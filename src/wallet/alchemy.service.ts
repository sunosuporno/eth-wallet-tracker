import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface AssetTransfer {
  category: string;
  blockNum: string;
  from: string | null;
  to: string | null;
  value: number | null;
  erc721TokenId?: string | null;
  erc1155Metadata?: Array<{ tokenId: string; value: string }> | null;
  tokenId?: string;
  asset: string | null;
  uniqueId: string;
  hash: string;
  rawContract?: {
    value: string | null;
    address: string | null;
    decimal: string | null;
  };
  metadata?: {
    blockTimestamp?: string;
  };
}

interface AssetTransfersResponse {
  transfers: AssetTransfer[];
  pageKey?: string;
}

interface MergedAssetTransfersResult {
  transfers: AssetTransfer[];
  pageKey?: string;
}

@Injectable()
export class AlchemyService implements OnModuleInit {
  private apiKey: string;
  private baseUrl: string;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {}

  onModuleInit() {
    const apiKeyOrUrl = this.configService.get<string>('ALCHEMY_API_KEY') || '';
    const network = this.configService.get<string>('ALCHEMY_NETWORK') || 'eth-mainnet';

    if (!apiKeyOrUrl) {
      throw new Error('ALCHEMY_API_KEY is required in environment variables');
    }

    // Extract API key from URL if full URL is provided
    if (apiKeyOrUrl.startsWith('http')) {
      // Extract the API key from the URL (last part after /v2/)
      const urlParts = apiKeyOrUrl.split('/v2/');
      this.apiKey = urlParts.length > 1 ? urlParts[1] : apiKeyOrUrl;
    } else {
      this.apiKey = apiKeyOrUrl;
    }

    // Construct base URL based on network
    this.baseUrl = `https://${network}.g.alchemy.com/v2/${this.apiKey}`;
  }

  /**
   * Retry helper with exponential backoff for 5xx errors
   * Retries after 3s, 6s, and 12s on server errors
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    serviceName: string = 'Alchemy',
  ): Promise<T> {
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
            `[${serviceName}Service] 5xx error (${status}), retrying in ${delay / 1000}s (attempt ${attempt + 2}/${delays.length + 1})...`,
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
   * Fetch all pages of asset transfers for a single direction (incoming or outgoing)
   * Handles pagination automatically
   */
  private async fetchAllPages(
    params: any,
    direction: 'incoming' | 'outgoing',
  ): Promise<AssetTransfer[]> {
    const allTransfers: AssetTransfer[] = [];
    let currentPageKey: string | undefined = params.pageKey;
    let pageCount = 0;

    console.log(
      `[AlchemyService] Fetching all ${direction} transfers (starting from pageKey: ${currentPageKey || 'none'})...`,
    );
    const startTime = Date.now();

    // Maximum transactions to fetch per direction (prevents memory issues)
    const MAX_TRANSACTIONS_PER_DIRECTION = 50000;

    do {
      pageCount++;
      const pageParams = { ...params, pageKey: currentPageKey };
      const response = await this.callAssetTransfersApi(pageParams);

      // Check if adding this page would exceed the limit
      if (allTransfers.length + response.transfers.length > MAX_TRANSACTIONS_PER_DIRECTION) {
        const remaining = MAX_TRANSACTIONS_PER_DIRECTION - allTransfers.length;
        if (remaining > 0) {
          allTransfers.push(...response.transfers.slice(0, remaining));
          console.warn(
            `[AlchemyService] ${direction}: Reached transaction limit (${MAX_TRANSACTIONS_PER_DIRECTION}). Truncating at ${allTransfers.length} transfers.`,
          );
        } else {
          console.warn(
            `[AlchemyService] ${direction}: Reached transaction limit (${MAX_TRANSACTIONS_PER_DIRECTION}). Stopping fetch.`,
          );
        }
        break;
      }

      allTransfers.push(...response.transfers);
      currentPageKey = response.pageKey;

      console.log(
        `[AlchemyService] ${direction} page ${pageCount}: ${response.transfers.length} transfers${currentPageKey ? ' (more pages available)' : ' (last page)'}`,
      );

      // Safety limit to prevent infinite loops (max 100 pages = ~100k transfers)
      if (pageCount >= 100) {
        console.warn(
          `[AlchemyService] Reached maximum page limit (100) for ${direction} transfers. There may be more data available.`,
        );
        break;
      }
    } while (currentPageKey);

    const duration = Date.now() - startTime;
    console.log(
      `[AlchemyService] ${direction}: Fetched ${allTransfers.length} total transfers across ${pageCount} pages in ${duration}ms`,
    );

    return allTransfers;
  }

  /**
   * Get all asset transfers (ETH and tokens) for a wallet
   * Fetches both incoming and outgoing transfers with automatic pagination
   * Based on: https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers
   */
  async getAssetTransfers(
    address: string,
    fromBlock: string,
    pageKey?: string,
  ): Promise<MergedAssetTransfersResult> {
    try {
      console.log(
        `[AlchemyService] getAssetTransfers - address: ${address}, fromBlock: ${fromBlock}`,
      );
      // Fetch ERC20 token transfers and ETH (external) transfers
      const categories = ['external', 'erc20'];

      // Fetch all outgoing transfers (from this address) with pagination
      const outgoingPromise = this.fetchAllPages(
        {
          fromBlock: fromBlock,
          toBlock: 'latest',
          fromAddress: address,
          category: categories,
          excludeZeroValue: false,
          withMetadata: true,
          order: 'desc',
          pageKey: pageKey,
        },
        'outgoing',
      );

      // Fetch all incoming transfers (to this address) with pagination
      const incomingPromise = this.fetchAllPages(
        {
          fromBlock: fromBlock,
          toBlock: 'latest',
          toAddress: address,
          category: categories,
          excludeZeroValue: false,
          withMetadata: true,
          order: 'desc',
          pageKey: pageKey,
        },
        'incoming',
      );

      // Execute both queries in parallel
      const [outgoingTransfers, incomingTransfers] = await Promise.all([
        outgoingPromise,
        incomingPromise,
      ]);

      // Merge results and remove duplicates
      const allTransfers = [...outgoingTransfers, ...incomingTransfers];
      const uniqueTransfers = Array.from(
        new Map(allTransfers.map((t) => [t.hash + t.uniqueId, t])).values(),
      );

      // Sort by block number (most recent first)
      uniqueTransfers.sort((a, b) => {
        const blockA = parseInt(a.blockNum, 16) || 0;
        const blockB = parseInt(b.blockNum, 16) || 0;
        return blockB - blockA;
      });

      console.log(
        `[AlchemyService] Merged to ${uniqueTransfers.length} unique transfers (outgoing: ${outgoingTransfers.length}, incoming: ${incomingTransfers.length})`,
      );

      // Note: pageKey is no longer meaningful since we fetched all pages
      // But we keep it in the interface for backward compatibility
      return {
        transfers: uniqueTransfers,
        pageKey: undefined, // All pages fetched, no more pages
      };
    } catch (error: any) {
      console.error(`[AlchemyService] Error fetching asset transfers:`, error.message);
      throw new Error(`Failed to fetch asset transfers: ${error.message}`);
    }
  }

  /**
   * Call Alchemy Asset Transfers API
   * Based on: https://www.alchemy.com/docs/how-to-get-transaction-history-for-an-address-on-ethereum
   */
  private async callAssetTransfersApi(params: any): Promise<AssetTransfersResponse> {
    const apiStart = Date.now();
    const direction = params.fromAddress ? 'outgoing' : 'incoming';
    console.log(`[AlchemyService] API call - ${direction}, fromBlock: ${params.fromBlock}`);

    // Alchemy API uses JSON-RPC format
    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [params],
    };

    // Log the exact API call structure for debugging
    console.log(`[AlchemyService] API request body:`, JSON.stringify(requestBody, null, 2));

    return this.retryWithBackoff(async () => {
      const response = await firstValueFrom(
        this.httpService.post<{ result: AssetTransfersResponse }>(this.baseUrl, requestBody, {
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );

      const apiDuration = Date.now() - apiStart;
      console.log(`[AlchemyService] API call completed in ${apiDuration}ms`);

      // Response structure: { result: { transfers: [...], pageKey: "..." } }
      const data = response.data as { result: AssetTransfersResponse };
      if (data?.result) {
        return data.result;
      }
      if (data && typeof data === 'object' && 'transfers' in data) {
        return data as AssetTransfersResponse;
      }
      throw new Error('Unexpected response format from Alchemy API');
    }).catch((error: any) => {
      if (error.response) {
        const status = error.response.status;
        const statusText = error.response.statusText;
        const errorData = error.response.data;
        throw new Error(
          `Alchemy API error (${status} ${statusText}): ${JSON.stringify(errorData)}. URL: ${this.baseUrl}`,
        );
      }
      if (error.message) {
        throw new Error(`Failed to call Alchemy API: ${error.message}`);
      }
      throw error;
    });
  }

  /**
   * Get token metadata using JSON-RPC
   */
  async getTokenMetadata(contractAddress: string) {
    try {
      return await this.retryWithBackoff(async () => {
        const response = await firstValueFrom(
          this.httpService.post<{ result?: any }>(
            this.baseUrl,
            {
              id: 1,
              jsonrpc: '2.0',
              method: 'alchemy_getTokenMetadata',
              params: [contractAddress],
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
            },
          ),
        );

        const data = response.data as { result?: any };
        if (data?.result) {
          return data.result;
        }
        return data || null;
      });
    } catch (error: any) {
      // Token metadata might not be available for all tokens
      return null;
    }
  }

  /**
   * Convert wei to ETH
   */
  formatEther(wei: string): string {
    const weiBigInt = BigInt(wei);
    const divisor = BigInt('1000000000000000000'); // 10^18
    const eth = Number(weiBigInt) / Number(divisor);
    return eth.toFixed(18).replace(/\.?0+$/, '');
  }

  /**
   * Get current block number using JSON-RPC
   */
  async getCurrentBlockNumber(): Promise<number> {
    console.log('[AlchemyService] Getting current block number...');
    const start = Date.now();

    try {
      const response = await this.retryWithBackoff(async () => {
        return await firstValueFrom(
          this.httpService.post<{ result: string }>(
            this.baseUrl,
            {
              id: 1,
              jsonrpc: '2.0',
              method: 'eth_blockNumber',
              params: [],
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
            },
          ),
        );
      });

      const data = response.data as { result?: string };
      const blockHex = data?.result || '0x0';
      const blockNumber = parseInt(blockHex, 16);
      const duration = Date.now() - start;
      console.log(
        `[AlchemyService] Current block number: ${blockNumber} (fetched in ${duration}ms)`,
      );
      return blockNumber;
    } catch (error: any) {
      console.error('[AlchemyService] Error getting block number:', error.message);
      throw new Error(`Failed to get current block number: ${error.message}`);
    }
  }

  /**
   * Check if an address is a smart contract using eth_getCode
   * Returns true if address has code (is a contract), false if EOA (Externally Owned Account)
   */
  async isContract(address: string): Promise<boolean> {
    try {
      const response = await this.retryWithBackoff(async () => {
        return await firstValueFrom(
          this.httpService.post<{ result: string }>(
            this.baseUrl,
            {
              id: 1,
              jsonrpc: '2.0',
              method: 'eth_getCode',
              params: [address.toLowerCase(), 'latest'],
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
            },
          ),
        );
      });

      const data = response.data as { result?: string };
      const code = data?.result || '0x';
      // If code is '0x' or '0x0', it's an EOA (no contract code)
      // If code has any other value, it's a contract
      return code !== '0x' && code !== '0x0';
    } catch (error: any) {
      // If we can't determine, assume it's not a contract
      console.log(
        `[AlchemyService] Could not determine if ${address} is a contract:`,
        error.message,
      );
      return false;
    }
  }

  /**
   * Get ETH balance of an address in wei, then convert to ETH
   * Returns balance as a number in ETH
   */
  async getEthBalance(address: string): Promise<number> {
    try {
      const response = await this.retryWithBackoff(async () => {
        return await firstValueFrom(
          this.httpService.post<{ result: string }>(
            this.baseUrl,
            {
              id: 1,
              jsonrpc: '2.0',
              method: 'eth_getBalance',
              params: [address.toLowerCase(), 'latest'],
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
            },
          ),
        );
      });

      const data = response.data as { result?: string };
      const balanceWei = data?.result || '0x0';
      // Convert from hex wei to decimal ETH (1 ETH = 10^18 wei)
      const balanceWeiBigInt = BigInt(balanceWei);
      const balanceEth = Number(balanceWeiBigInt) / 1e18;
      return balanceEth;
    } catch (error: any) {
      console.error(`[AlchemyService] Error getting ETH balance for ${address}:`, error.message);
      return 0; // Return 0 on error
    }
  }
}
