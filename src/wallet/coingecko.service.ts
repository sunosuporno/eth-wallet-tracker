import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface CoinGeckoCoin {
  id: string;
  symbol: string;
  name: string;
}

@Injectable()
export class CoinGeckoService {
  private apiKey: string;
  private baseUrl = 'https://api.coingecko.com/api/v3';

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    this.apiKey = this.configService.get<string>('COINGECKO_API_KEY') || '';
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
            `[CoinGeckoService] 5xx error (${status}), retrying in ${delay / 1000}s (attempt ${attempt + 2}/${delays.length + 1})...`,
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
   * Get Ethereum price from CoinGecko
   */
  async getEthPrice(): Promise<number | null> {
    try {
      const options = {
        method: 'GET',
        headers: this.apiKey ? { 'x-cg-demo-api-key': this.apiKey } : {},
      };

      // Use the main Ethereum coin ID
      const response = await this.retryWithBackoff(async () => {
        return await firstValueFrom(
          this.httpService.get<{ ethereum: { usd: number } }>(
            `${this.baseUrl}/simple/price?ids=ethereum&vs_currencies=usd`,
            options,
          ),
        );
      });

      const price = response.data?.ethereum?.usd;
      return price || null;
    } catch (error: any) {
      return null; // Don't fail the whole request if price fetch fails
    }
  }

  /**
   * Get token price by contract address from CoinGecko
   * @param contractAddress - Ethereum contract address (lowercase)
   * @param platform - Platform ID (default: 'ethereum')
   */
  async getTokenPrice(
    contractAddress: string,
    platform: string = 'ethereum',
  ): Promise<number | null> {
    try {
      const options = {
        method: 'GET',
        headers: this.apiKey ? { 'x-cg-demo-api-key': this.apiKey } : {},
      };

      // CoinGecko API endpoint for token price by contract address
      // Documentation: https://docs.coingecko.com/v3.0.1/reference/simple-token-price
      const normalizedAddress = contractAddress.toLowerCase();
      const response = await this.retryWithBackoff(async () => {
        return await firstValueFrom(
          this.httpService.get<{ [key: string]: { usd: number } }>(
            `${this.baseUrl}/simple/token_price/${platform}?contract_addresses=${normalizedAddress}&vs_currencies=usd`,
            options,
          ),
        );
      });

      // The response key is the contract address (normalized to lowercase by CoinGecko)
      // Try both the normalized address and the original in case of case sensitivity
      const priceData = response.data?.[normalizedAddress] || response.data?.[contractAddress];
      return priceData?.usd || null;
    } catch (error: any) {
      // Don't fail the whole request if price fetch fails
      console.log(
        `[CoinGeckoService] Failed to fetch price for token ${contractAddress}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Batch fetch token prices by contract addresses from CoinGecko
   * @param contractAddresses - Array of Ethereum contract addresses
   * @param platform - Platform ID (default: 'ethereum')
   * @returns Map of contract address (lowercase) to price
   */
  async getTokenPricesBatch(
    contractAddresses: string[],
    platform: string = 'ethereum',
  ): Promise<Map<string, number | null>> {
    if (contractAddresses.length === 0) {
      return new Map();
    }

    try {
      const options = {
        method: 'GET',
        headers: this.apiKey ? { 'x-cg-demo-api-key': this.apiKey } : {},
      };

      // Normalize all addresses to lowercase
      const normalizedAddresses = contractAddresses.map((addr) => addr.toLowerCase());
      const addressesParam = normalizedAddresses.join(',');

      // CoinGecko API endpoint supports multiple contract addresses
      const response = await this.retryWithBackoff(async () => {
        return await firstValueFrom(
          this.httpService.get<{ [key: string]: { usd: number } }>(
            `${this.baseUrl}/simple/token_price/${platform}?contract_addresses=${addressesParam}&vs_currencies=usd`,
            options,
          ),
        );
      });

      // Build map of address -> price
      const priceMap = new Map<string, number | null>();
      for (const address of normalizedAddresses) {
        const priceData = response.data?.[address];
        priceMap.set(address, priceData?.usd || null);
      }

      return priceMap;
    } catch (error: any) {
      // Don't fail the whole request if price fetch fails
      console.log(
        `[CoinGeckoService] Failed to batch fetch prices for ${contractAddresses.length} tokens:`,
        error.message,
      );
      // Return map with null values for all addresses
      const priceMap = new Map<string, number | null>();
      contractAddresses.forEach((addr) => {
        priceMap.set(addr.toLowerCase(), null);
      });
      return priceMap;
    }
  }
}
