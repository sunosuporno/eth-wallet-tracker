import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface EtherscanSourceCodeResponse {
  status: string;
  message: string;
  result: Array<{
    SourceCode: string;
    ABI: string;
    ContractName: string;
    CompilerVersion: string;
    OptimizationUsed: string;
    Runs: string;
    ConstructorArguments: string;
    EVMVersion: string;
    Library: string;
    LicenseType: string;
    Proxy: string;
    Implementation: string;
    SwarmSource: string;
    SimilarMatch?: string;
  }>;
}

export interface ContractVerificationStatus {
  isVerified: boolean;
  contractName: string | null;
  hasSourceCode: boolean;
  hasABI: boolean;
  isSimilarMatch: boolean;
  similarMatchAddress: string | null;
}

@Injectable()
export class EtherscanService {
  private apiKey: string;
  private baseUrl = 'https://api.etherscan.io/v2/api';

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    this.apiKey = this.configService.get<string>('ETHERSCAN_API_KEY') || '';
  }

  /**
   * Retry helper with exponential backoff for 5xx errors
   * Retries after 3s, 6s, and 12s on server errors
   */
  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    const delays = [3000, 6000, 12000]; // 3s, 6s, 12s
    let lastError: any;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        const status = error?.response?.status;

        // Only retry on 5xx errors
        if (status && status >= 500 && status < 600 && attempt < delays.length) {
          const delay = delays[attempt];
          console.log(
            `[EtherscanService] 5xx error (${status}), retrying in ${delay / 1000}s (attempt ${attempt + 2}/${delays.length + 1})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Not a 5xx error or out of retries, throw immediately
        throw error;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError;
  }

  /**
   * Check if a contract is verified on Etherscan
   * @param contractAddress - Ethereum contract address
   * @returns ContractVerificationStatus object with verification details
   */
  async checkContractVerification(
    contractAddress: string,
  ): Promise<ContractVerificationStatus> {
    if (!this.apiKey) {
      console.warn('[EtherscanService] ETHERSCAN_API_KEY not configured');
      return {
        isVerified: false,
        contractName: null,
        hasSourceCode: false,
        hasABI: false,
        isSimilarMatch: false,
        similarMatchAddress: null,
      };
    }

    try {
      const normalizedAddress = contractAddress.toLowerCase();
      const response = await this.retryWithBackoff(async () => {
        return await firstValueFrom(
          this.httpService.get<EtherscanSourceCodeResponse>(this.baseUrl, {
            params: {
              module: 'contract',
              action: 'getsourcecode',
              address: normalizedAddress,
              apikey: this.apiKey,
            },
          }),
        );
      });

      // Check if request was successful
      if (response.data.status !== '1' || !response.data.result || response.data.result.length === 0) {
        return {
          isVerified: false,
          contractName: null,
          hasSourceCode: false,
          hasABI: false,
          isSimilarMatch: false,
          similarMatchAddress: null,
        };
      }

      const contractData = response.data.result[0];

      // Check if contract is verified
      const hasSourceCode =
        contractData.SourceCode &&
        contractData.SourceCode.trim() !== '' &&
        contractData.SourceCode !== '{{' && // Sometimes unverified contracts return this
        !contractData.SourceCode.startsWith('{'); // JSON wrapper for verified contracts

      const hasABI =
        contractData.ABI &&
        contractData.ABI !== 'Contract source code not verified' &&
        contractData.ABI.trim() !== '';

      const contractName =
        contractData.ContractName && contractData.ContractName.trim() !== ''
          ? contractData.ContractName
          : null;

      const isSimilarMatch = !!contractData.SimilarMatch && contractData.SimilarMatch.trim() !== '';
      const similarMatchAddress = isSimilarMatch ? contractData.SimilarMatch : null;

      // Contract is considered verified if it has source code OR ABI (and not the "not verified" message)
      const isVerified = hasSourceCode || (hasABI && contractData.ABI !== 'Contract source code not verified');

      return {
        isVerified,
        contractName,
        hasSourceCode,
        hasABI,
        isSimilarMatch,
        similarMatchAddress,
      };
    } catch (error: any) {
      // Don't fail the whole request if verification check fails
      console.log(
        `[EtherscanService] Failed to check verification for contract ${contractAddress}:`,
        error.message,
      );
      return {
        isVerified: false,
        contractName: null,
        hasSourceCode: false,
        hasABI: false,
        isSimilarMatch: false,
        similarMatchAddress: null,
      };
    }
  }

  /**
   * Batch check contract verification status for multiple addresses
   * Note: Etherscan API doesn't support true batching, so this makes sequential calls
   * with rate limiting consideration (5 calls/second for free tier)
   * @param contractAddresses - Array of Ethereum contract addresses
   * @returns Map of contract address (lowercase) to verification status
   */
  async checkContractVerificationBatch(
    contractAddresses: string[],
  ): Promise<Map<string, ContractVerificationStatus>> {
    const resultMap = new Map<string, ContractVerificationStatus>();

    if (contractAddresses.length === 0) {
      return resultMap;
    }

    // Process in batches to respect rate limits (5 calls/second for free tier)
    const batchSize = 4; // Conservative: 4 calls per batch to stay under 5/sec
    const delayBetweenBatches = 1100; // 1.1 seconds between batches

    for (let i = 0; i < contractAddresses.length; i += batchSize) {
      const batch = contractAddresses.slice(i, i + batchSize);
      const batchPromises = batch.map((address) =>
        this.checkContractVerification(address).then((status) => ({
          address: address.toLowerCase(),
          status,
        })),
      );

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(({ address, status }) => {
        resultMap.set(address, status);
      });

      // Add delay between batches (except for the last batch)
      if (i + batchSize < contractAddresses.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }

    return resultMap;
  }
}
