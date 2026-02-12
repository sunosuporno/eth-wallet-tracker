import { Injectable } from '@nestjs/common';
import { AlchemyService } from './alchemy.service';
import { CoinGeckoService } from './coingecko.service';
import {
  WalletTraceResponse,
  TransactionFlow,
  TokenTransfer,
  WalletGraph,
  GraphNode,
  GraphEdge,
} from './dto/wallet-trace-response.dto';
import { writeFile } from 'fs/promises';
import { join } from 'path';

interface TokenMetadata {
  name?: string;
  symbol?: string;
  decimals?: number;
}

interface TokenCache {
  metadata: Map<string, TokenMetadata | null>; // contractAddress -> metadata
  prices: Map<string, number | null>; // contractAddress -> price
}

@Injectable()
export class WalletTracerService {
  // Stablecoin contract addresses (always $1)
  private readonly USDT_ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  private readonly USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

  // Stablecoin constants
  private readonly STABLECOIN_DECIMALS = 6;
  private readonly STABLECOIN_DIVISOR = BigInt(10 ** 6);

  // High-volume wallet protection
  private readonly MAX_TRANSACTIONS = 50000; // Maximum transactions to process before truncation

  constructor(
    private alchemyService: AlchemyService,
    private coinGeckoService: CoinGeckoService,
  ) {}

  /**
   * Check if a contract address is USDC or USDT
   */
  private isStablecoin(contractAddress: string): boolean {
    const normalized = contractAddress.toLowerCase();
    return normalized === this.USDT_ADDRESS || normalized === this.USDC_ADDRESS;
  }

  /**
   * Get the symbol for a stablecoin contract address
   */
  private getStablecoinSymbol(contractAddress: string): string | null {
    const normalized = contractAddress.toLowerCase();
    if (normalized === this.USDT_ADDRESS) return 'USDT';
    if (normalized === this.USDC_ADDRESS) return 'USDC';
    return null;
  }

  /**
   * Extract raw value from transfer (ERC20 or external)
   * Returns the raw value as a string
   */
  private getRawValueFromTransfer(transfer: any): string {
    if (transfer.rawContract?.value) {
      return BigInt(transfer.rawContract.value).toString();
    } else if (transfer.value !== null && transfer.value !== undefined) {
      return Math.floor(transfer.value).toString();
    }
    return '0';
  }

  /**
   * Calculate fromBlock based on current block and days
   */
  private calculateFromBlock(
    currentBlock: number,
    days: number,
  ): { fromBlockNumber: number; fromBlock: string } {
    const blocksPerDay = 7200; // (24 hours * 60 minutes * 60 seconds) / 12 seconds per block
    const blocksToSubtract = days * blocksPerDay;
    const fromBlockNumber = Math.max(0, currentBlock - blocksToSubtract);
    const fromBlock = `0x${fromBlockNumber.toString(16)}`;
    return { fromBlockNumber, fromBlock };
  }

  /**
   * Parse USD value string to number (removes $ and commas)
   */
  private parseUsdValue(usdString: string): number {
    return parseFloat(usdString.replace('$', '').replace(/,/g, ''));
  }

  /**
   * Convert ETH string to wei (bigint) without precision loss
   * Handles decimal ETH values accurately
   */
  private ethStringToWei(ethString: string): bigint {
    if (!ethString || ethString === '0') return BigInt(0);

    // Split into integer and decimal parts
    const parts = ethString.split('.');
    const integerPart = parts[0] || '0';
    const decimalPart = parts[1] || '';

    // Pad decimal part to 18 digits and truncate if longer
    const paddedDecimal = decimalPart.padEnd(18, '0').slice(0, 18);

    // Combine: integerPart * 10^18 + decimalPart
    const integerWei = BigInt(integerPart) * BigInt(10 ** 18);
    const decimalWei = BigInt(paddedDecimal);

    return integerWei + decimalWei;
  }

  /**
   * Convert wei (bigint) to ETH number directly without string intermediate
   */
  private weiToEthNumber(wei: bigint): number {
    const divisor = BigInt(10 ** 18);
    return Number(wei) / Number(divisor);
  }

  /**
   * Calculate stablecoin USD value from raw ERC20 value
   */
  private calculateStablecoinUsdValue(erc20Value: bigint): number {
    return Number(erc20Value) / Number(this.STABLECOIN_DIVISOR);
  }

  /**
   * Convert stablecoin value to ETH equivalent in wei
   */
  private stablecoinToEthWei(erc20Value: bigint, ethPrice: number): bigint {
    const stablecoinUsdValue = this.calculateStablecoinUsdValue(erc20Value);
    const ethEquivalent = stablecoinUsdValue / ethPrice;
    return BigInt(Math.floor(ethEquivalent * 1e18));
  }

  /**
   * Calculate token divisor from decimals
   */
  private calculateTokenDivisor(decimals: number): bigint {
    return BigInt(10 ** decimals);
  }

  /**
   * Batch fetch token metadata and prices for unique token addresses
   * Updates the tokenCache with fetched data
   */
  private async batchFetchTokenData(
    tokenAddresses: string[],
    tokenCache: TokenCache,
  ): Promise<void> {
    if (tokenAddresses.length === 0) return;

    console.log(
      `[batchFetchTokenData] Fetching metadata and prices for ${tokenAddresses.length} tokens...`,
    );
    const fetchStart = Date.now();

    // Filter out addresses already in cache
    const addressesToFetch = tokenAddresses.filter(
      (addr) => !tokenCache.metadata.has(addr.toLowerCase()),
    );

    if (addressesToFetch.length === 0) {
      console.log(`[batchFetchTokenData] All ${tokenAddresses.length} tokens already in cache`);
      return;
    }

    console.log(
      `[batchFetchTokenData] Fetching ${addressesToFetch.length} new tokens (${tokenAddresses.length - addressesToFetch.length} already cached)`,
    );

    // Batch fetch metadata in parallel
    const metadataPromises = addressesToFetch.map(async (address) => {
      const normalizedAddr = address.toLowerCase();
      try {
        const metadata = await this.alchemyService.getTokenMetadata(normalizedAddr);
        return { address: normalizedAddr, metadata };
      } catch (error) {
        return { address: normalizedAddr, metadata: null };
      }
    });

    // Batch fetch prices (single API call for all addresses)
    const pricePromise = this.coinGeckoService.getTokenPricesBatch(addressesToFetch);

    // Wait for both to complete
    const [metadataResults, priceMap] = await Promise.all([
      Promise.all(metadataPromises),
      pricePromise,
    ]);

    // Update cache
    for (const { address, metadata } of metadataResults) {
      tokenCache.metadata.set(address, metadata);
    }

    for (const [address, price] of priceMap.entries()) {
      tokenCache.prices.set(address, price);
    }

    const fetchDuration = Date.now() - fetchStart;
    console.log(
      `[batchFetchTokenData] Fetched ${addressesToFetch.length} tokens in ${fetchDuration}ms`,
    );
  }

  /**
   * Trace wallet and analyze value flows with optional multi-hop tracing
   */
  async traceWallet(
    address: string,
    days: number = 30,
    pageKey?: string,
    minEthAmount?: number,
    minUsdAmount?: number,
    hops: number = 2,
  ): Promise<WalletTraceResponse> {
    console.log(
      `[WalletTracerService] traceWallet called - address: ${address}, days: ${days}, hops: ${hops}, minEthAmount: ${minEthAmount}, minUsdAmount: ${minUsdAmount}`,
    );

    // Normalize address to checksum format
    const normalizedAddress = address.toLowerCase();
    console.log(`[WalletTracerService] Normalized address: ${normalizedAddress}`);

    // Fetch ETH price from CoinGecko (we need this for USD calculations and conversion)
    let ethPrice: number | null = null;
    try {
      console.log('[WalletTracerService] Fetching ETH price...');
      ethPrice = await this.coinGeckoService.getEthPrice();
      console.log(`[WalletTracerService] ETH price: $${ethPrice}`);
    } catch (err: any) {
      console.log(
        '[WalletTracerService] Failed to fetch ETH price, continuing without it:',
        err.message,
      );
      // Continue without price - USD values will be null
    }

    // Validate minUsdAmount if provided (ETH price required for filtering)
    if (minUsdAmount !== undefined && minUsdAmount > 0) {
      if (ethPrice === null || ethPrice <= 0) {
        throw new Error('Cannot filter by USD amount: ETH price not available');
      }
      console.log(
        `[WalletTracerService] Filtering transactions with minimum USD value: $${minUsdAmount}`,
      );
    }

    // Calculate fromBlock based on days
    // Block time is 12 seconds, so blocks per day = (24 * 60 * 60) / 12 = 7200 blocks/day
    console.log('[WalletTracerService] Getting current block number...');
    const currentBlock = await this.alchemyService.getCurrentBlockNumber();
    console.log(`[WalletTracerService] Current block: ${currentBlock}`);
    const { fromBlockNumber, fromBlock } = this.calculateFromBlock(currentBlock, days);
    console.log(`[WalletTracerService] From block: ${fromBlockNumber} (${fromBlock})`);

    // Get all asset transfers
    console.log('[WalletTracerService] Fetching asset transfers for center address...');
    const transfersStartTime = Date.now();
    const transfersResult = await this.alchemyService.getAssetTransfers(
      normalizedAddress,
      fromBlock,
      pageKey,
    );
    const transfersDuration = Date.now() - transfersStartTime;
    console.log(
      `[WalletTracerService] Fetched ${transfersResult.transfers.length} transfers in ${transfersDuration}ms`,
    );

    // Filter transfers by block number to ensure they're within the date range
    // This is a safety check in case the API doesn't properly respect fromBlock
    const filteredTransfers = transfersResult.transfers.filter((transfer) => {
      if (!transfer.blockNum) return false;
      const transferBlock =
        typeof transfer.blockNum === 'string' ? parseInt(transfer.blockNum, 16) : transfer.blockNum;
      return transferBlock >= fromBlockNumber;
    });

    console.log(
      `[WalletTracerService] Filtered to ${filteredTransfers.length} transfers within block range (fromBlock: ${fromBlockNumber})`,
    );

    // Check for high-volume wallet and truncate if necessary
    let truncated = false;
    let truncationWarning: string | undefined;
    let transfersToProcess = filteredTransfers;

    if (filteredTransfers.length > this.MAX_TRANSACTIONS) {
      truncated = true;
      transfersToProcess = filteredTransfers.slice(0, this.MAX_TRANSACTIONS);
      const truncatedCount = filteredTransfers.length - this.MAX_TRANSACTIONS;
      truncationWarning = `⚠️ High-volume wallet detected: ${filteredTransfers.length} transactions found. Processing first ${this.MAX_TRANSACTIONS} transactions (${truncatedCount} truncated). Consider reducing the 'days' parameter or increasing 'minUsdAmount' to get complete results.`;
      console.warn(`[WalletTracerService] ${truncationWarning}`);
    } else if (filteredTransfers.length > 10000) {
      // Warning for approaching limit
      console.warn(
        `[WalletTracerService] ⚠️ High transaction volume: ${filteredTransfers.length} transactions. Consider reducing 'days' or increasing 'minUsdAmount' for better performance.`,
      );
    }

    // Initialize token cache (shared across center wallet and hops)
    const tokenCache: TokenCache = {
      metadata: new Map(),
      prices: new Map(),
    };

    // First pass: Collect unique non-stablecoin ERC20 token addresses
    const uniqueTokenAddresses = new Set<string>();
    for (const transfer of transfersToProcess) {
      if (transfer.category === 'erc20') {
        const contractAddress = transfer.rawContract?.address?.toLowerCase() || '';
        if (contractAddress && !this.isStablecoin(contractAddress)) {
          uniqueTokenAddresses.add(contractAddress);
        }
      }
    }

    // Batch fetch token metadata and prices
    if (uniqueTokenAddresses.size > 0) {
      await this.batchFetchTokenData(Array.from(uniqueTokenAddresses), tokenCache);
    }

    const transactions: TransactionFlow[] = [];
    const sentToAddresses = new Set<string>();
    const receivedFromAddresses = new Set<string>();
    let totalIncoming = BigInt(0);
    let totalOutgoing = BigInt(0);

    // Process each transfer (using transfersToProcess, which may be truncated)
    for (const transfer of transfersToProcess) {
      const isIncoming = transfer.to?.toLowerCase() === normalizedAddress;
      const isOutgoing = transfer.from?.toLowerCase() === normalizedAddress;

      if (!isIncoming && !isOutgoing) continue;

      // Extract raw value in wei, then convert to USD for filtering
      let value = BigInt(0);
      if (transfer.category === 'external') {
        // For external transfers, check rawContract.value first (hex string in wei)
        const rawValue = transfer.rawContract?.value;
        if (rawValue) {
          value = BigInt(rawValue);
        } else if (transfer.value !== null && transfer.value !== undefined) {
          // Fallback to value field (should be in wei)
          value = BigInt(Math.floor(transfer.value));
        }
      }

      // CRITICAL: Apply minimum USD amount filter FIRST - before ANY processing
      // This ensures addresses, transactions, and edges only include filtered data
      if (transfer.category === 'external') {
        if (minUsdAmount !== undefined && minUsdAmount > 0 && ethPrice) {
          const ethValue = this.weiToEthNumber(value);
          const usdValue = ethValue * ethPrice;
          if (usdValue < minUsdAmount || value === 0n) {
            continue; // Skip this transaction entirely - don't track addresses, don't count it, don't add to transactions
          }
        }
      }

      // Handle ERC20 transfers - only USDC and USDT are included in filtering and hops
      let erc20Value = BigInt(0);
      let erc20ContractAddress = '';
      let isStablecoin = false;

      if (transfer.category === 'erc20') {
        erc20ContractAddress = transfer.rawContract?.address?.toLowerCase() || '';
        isStablecoin = this.isStablecoin(erc20ContractAddress);

        if (isStablecoin) {
          // Get raw value for USDC/USDT
          if (transfer.rawContract?.value) {
            erc20Value = BigInt(transfer.rawContract.value);
          } else if (transfer.value !== null && transfer.value !== undefined) {
            erc20Value = BigInt(Math.floor(transfer.value));
          }

          // USDC/USDT have 6 decimals, calculate USD value (always $1 per token)
          if (erc20Value > 0n) {
            const usdValue = this.calculateStablecoinUsdValue(erc20Value);

            // Apply USD filter for stablecoins - compare USD to USD
            if (minUsdAmount !== undefined && minUsdAmount > 0) {
              if (usdValue < minUsdAmount) {
                continue; // Skip if below threshold
              }
            }
          }
        } else {
          // For non-stablecoin ERC20s, skip them for filtering and hops
          // They can still be included in transactions for center wallet if includeERC20 is true
          continue;
        }
      }

      // Track unique addresses from ETH, USDC, and USDT transactions that passed the filter
      if (transfer.category === 'external' || (transfer.category === 'erc20' && isStablecoin)) {
        if (isIncoming && transfer.from) {
          const fromAddr = transfer.from.toLowerCase();
          if (fromAddr && fromAddr !== normalizedAddress) {
            receivedFromAddresses.add(fromAddr);
          }
        }
        if (isOutgoing && transfer.to) {
          const toAddr = transfer.to.toLowerCase();
          if (toAddr && toAddr !== normalizedAddress) {
            sentToAddresses.add(toAddr);
          }
        }
      }

      // Track ETH and stablecoin values for summary
      if (transfer.category === 'external') {
        if (isIncoming) {
          totalIncoming = totalIncoming + value;
        } else {
          totalOutgoing = totalOutgoing + value;
        }
      } else if (transfer.category === 'erc20' && isStablecoin) {
        // For stablecoins, convert to ETH equivalent for summary (using $1 = current ETH price)
        // Actually, let's track stablecoin USD values separately or convert them
        // For now, we'll track them as USD values in the summary
        // Note: This is a simplification - we might want to track stablecoins separately
        if (ethPrice) {
          const ethEquivalentWei = this.stablecoinToEthWei(erc20Value, ethPrice);
          if (isIncoming) {
            totalIncoming = totalIncoming + ethEquivalentWei;
          } else {
            totalOutgoing = totalOutgoing + ethEquivalentWei;
          }
        }
      }

      // Parse block number
      let blockNumber = 0;
      if (transfer.blockNum) {
        // blockNum can be a hex string or number
        blockNumber =
          typeof transfer.blockNum === 'string'
            ? parseInt(transfer.blockNum, 16)
            : transfer.blockNum;
      }

      // Extract timestamp from metadata if available
      let timestamp = 0;
      if (transfer.metadata?.blockTimestamp) {
        timestamp = new Date(transfer.metadata.blockTimestamp).getTime();
      }

      // Calculate USD value for ETH transactions
      let valueUsd: string | undefined;
      if (transfer.category === 'external' && value > 0n && ethPrice) {
        const ethValue = this.weiToEthNumber(value);
        const usdValue = ethValue * ethPrice;
        valueUsd = `$${usdValue.toFixed(2)}`;
      }

      // Build transaction flow object
      const transactionFlow: TransactionFlow = {
        hash: transfer.hash,
        from: transfer.from?.toLowerCase() || '',
        to: transfer.to?.toLowerCase() || '',
        value: value > 0n ? this.alchemyService.formatEther(value.toString()) : '0',
        valueUsd: valueUsd,
        timestamp: timestamp,
        blockNumber: blockNumber,
        type: isIncoming ? 'incoming' : 'outgoing',
      };

      // Handle ERC20 token transfers
      if (transfer.category === 'erc20') {
        // Reuse the contract address and stablecoin check from early filtering
        const contractAddress =
          erc20ContractAddress || transfer.rawContract?.address?.toLowerCase() || '';

        if (!contractAddress) {
          continue;
        }

        // Reuse the stablecoin check result from early filtering (line 226)
        // No need to check again - we already have isStablecoin variable

        if (isStablecoin) {
          // USDC/USDT: Process like ETH - include in filtering and hops
          // Get raw value using helper method
          const rawValue = this.getRawValueFromTransfer(transfer);

          if (rawValue !== '0' && BigInt(rawValue) > 0n) {
            const tokenSymbol = this.getStablecoinSymbol(contractAddress);
            const valueBigInt = BigInt(rawValue);
            const formattedValue = Number(valueBigInt) / Number(this.STABLECOIN_DIVISOR);

            const tokenTransfer: TokenTransfer = {
              contractAddress: contractAddress,
              tokenName: tokenSymbol === 'USDC' ? 'USD Coin' : 'Tether USD',
              tokenSymbol: tokenSymbol || 'UNKNOWN',
              decimals: this.STABLECOIN_DECIMALS,
              value: formattedValue.toFixed(6).replace(/\.?0+$/, ''),
              valueUsd: `$${formattedValue.toFixed(2)}`, // USDC/USDT are always $1
              tokenPrice: 1, // Always $1
              from: transfer.from?.toLowerCase() || '',
              to: transfer.to?.toLowerCase() || '',
            };

            transactionFlow.tokenTransfers = [tokenTransfer];
            // Set USD value for the transaction flow (for stablecoins)
            transactionFlow.valueUsd = `$${formattedValue.toFixed(2)}`;
          }
        } else {
          // Other ERC20 tokens: Only include for center wallet (if includeERC20 is true)
          // Skip for hop addresses
          const rawValue = this.getRawValueFromTransfer(transfer);

          if (rawValue !== '0' && BigInt(rawValue) > 0n) {
            const tokenTransfer: TokenTransfer = {
              contractAddress: contractAddress,
              value: rawValue,
              from: transfer.from?.toLowerCase() || '',
              to: transfer.to?.toLowerCase() || '',
            };

            // Use cached token metadata and prices for other ERC20 tokens
            // contractAddress is already normalized, no need to normalize again
            const metadata = tokenCache.metadata.get(contractAddress);

            if (metadata) {
              tokenTransfer.tokenName = metadata.name;
              tokenTransfer.tokenSymbol = metadata.symbol;
              tokenTransfer.decimals = metadata.decimals;

              // Format the value using token decimals
              let formattedValue = 0;
              if (metadata.decimals !== undefined && metadata.decimals !== null) {
                const valueBigInt = BigInt(rawValue);
                const divisor = this.calculateTokenDivisor(metadata.decimals);
                formattedValue = Number(valueBigInt) / Number(divisor);
                tokenTransfer.value = formattedValue.toFixed(6).replace(/\.?0+$/, '');
              }

              // Get token price from cache
              const tokenPrice = tokenCache.prices.get(contractAddress);
              if (tokenPrice && formattedValue > 0) {
                tokenTransfer.tokenPrice = tokenPrice;
                const usdValue = formattedValue * tokenPrice;
                tokenTransfer.valueUsd = `$${usdValue.toFixed(2)}`;
              }
            }

            transactionFlow.tokenTransfers = [tokenTransfer];
          }
        }
      }

      // Add transaction to list - only transactions that passed the filter reach here
      if (transfer.category === 'external') {
        transactions.push(transactionFlow);
      } else if (transfer.category === 'erc20') {
        // Reuse the stablecoin check result from early filtering (line 226)
        // No need to check again - we already have isStablecoin variable

        if (isStablecoin) {
          // Stablecoins are always included - they're used for filtering and hops
          if (transactionFlow.tokenTransfers && transactionFlow.tokenTransfers.length > 0) {
            transactions.push(transactionFlow);
          }
        } else {
          // Other ERC20 tokens: Only include for center wallet
          if (transactionFlow.tokenTransfers && transactionFlow.tokenTransfers.length > 0) {
            transactions.push(transactionFlow);
          }
        }
      }
    }

    // Sort transactions by block number (most recent first)
    transactions.sort((a, b) => b.blockNumber - a.blockNumber);

    // Calculate net flow
    const netFlow = totalIncoming - totalOutgoing;

    // Transaction count - all transactions in array are already filtered
    const filteredTransactionCount = transactions.length;

    // Calculate USD totals and top 10 inflow/outflow sources by summing valueUsd from transactions
    const inflowSources = new Map<string, { totalUsd: number; count: number }>(); // address -> { totalUsd, count }
    const outflowSources = new Map<string, { totalUsd: number; count: number }>(); // address -> { totalUsd, count }
    let totalIncomingUsdSum = 0;
    let totalOutgoingUsdSum = 0;

    for (const tx of transactions) {
      let txUsdValue = 0;

      // Calculate USD value for this transaction
      if (tx.valueUsd) {
        txUsdValue = this.parseUsdValue(tx.valueUsd);
      } else if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
        // For token transfers, sum up all token USD values
        for (const token of tx.tokenTransfers) {
          if (token.valueUsd) {
            txUsdValue += this.parseUsdValue(token.valueUsd);
          }
        }
      }

      // Sum totals by transaction type
      if (txUsdValue > 0) {
        if (tx.type === 'incoming') {
          totalIncomingUsdSum += txUsdValue;
        } else if (tx.type === 'outgoing') {
          totalOutgoingUsdSum += txUsdValue;
        }
      }

      // Track top sources by address
      if (txUsdValue > 0) {
        if (tx.type === 'incoming') {
          // Incoming: money came FROM another address TO center wallet
          const fromAddr = tx.from.toLowerCase();
          if (fromAddr && fromAddr !== normalizedAddress) {
            const existing = inflowSources.get(fromAddr) || { totalUsd: 0, count: 0 };
            inflowSources.set(fromAddr, {
              totalUsd: existing.totalUsd + txUsdValue,
              count: existing.count + 1,
            });
          }
        } else if (tx.type === 'outgoing') {
          // Outgoing: money went FROM center wallet TO another address
          const toAddr = tx.to.toLowerCase();
          if (toAddr && toAddr !== normalizedAddress) {
            const existing = outflowSources.get(toAddr) || { totalUsd: 0, count: 0 };
            outflowSources.set(toAddr, {
              totalUsd: existing.totalUsd + txUsdValue,
              count: existing.count + 1,
            });
          }
        }
      }
    }

    // Sort and get top 10 inflow sources
    const topInflowSources = Array.from(inflowSources.entries())
      .map(([address, data]) => ({
        address,
        totalValueUsd: `$${data.totalUsd.toFixed(2)}`,
        transactionCount: data.count,
      }))
      .sort((a, b) => this.parseUsdValue(b.totalValueUsd) - this.parseUsdValue(a.totalValueUsd))
      .slice(0, 10);

    // Sort and get top 10 outflow sources
    const topOutflowSources = Array.from(outflowSources.entries())
      .map(([address, data]) => ({
        address,
        totalValueUsd: `$${data.totalUsd.toFixed(2)}`,
        transactionCount: data.count,
      }))
      .sort((a, b) => this.parseUsdValue(b.totalValueUsd) - this.parseUsdValue(a.totalValueUsd))
      .slice(0, 10);

    // Format USD totals from summed values (use valueUsd directly from transactions)
    const totalIncomingUsd = `$${totalIncomingUsdSum.toFixed(2)}`;
    const totalOutgoingUsd = `$${totalOutgoingUsdSum.toFixed(2)}`;
    const netFlowUsdValue = totalIncomingUsdSum - totalOutgoingUsdSum;
    const netFlowUsd = `$${netFlowUsdValue.toFixed(2)}`;

    const response: WalletTraceResponse = {
      walletAddress: normalizedAddress,
      summary: {
        totalIncoming: this.alchemyService.formatEther(totalIncoming.toString()),
        totalIncomingUsd: totalIncomingUsd,
        totalOutgoing: this.alchemyService.formatEther(totalOutgoing.toString()),
        totalOutgoingUsd: totalOutgoingUsd,
        netFlow: this.alchemyService.formatEther(netFlow.toString()),
        netFlowUsd: netFlowUsd,
        transactionCount: filteredTransactionCount, // Only filtered transactions
        uniqueAddresses: {
          sentTo: Array.from(sentToAddresses),
          receivedFrom: Array.from(receivedFromAddresses),
        },
        topInflowSources: topInflowSources.length > 0 ? topInflowSources : undefined,
        topOutflowSources: topOutflowSources.length > 0 ? topOutflowSources : undefined,
      },
      transactions,
      pageKey: transfersResult.pageKey,
      truncated: truncated,
      truncationWarning: truncationWarning,
    };

    // If hops > 0, perform multi-hop tracing
    if (hops > 0) {
      console.log(`[WalletTracerService] Starting multi-hop graph building with ${hops} hops...`);
      const graphStartTime = Date.now();

      // Reuse the center wallet data we already fetched instead of fetching again
      const centerData = {
        summary: response.summary,
        transactions: transactions,
        uniqueAddresses: {
          sentTo: Array.from(sentToAddresses),
          receivedFrom: Array.from(receivedFromAddresses),
        },
      };

      const graph = await this.buildMultiHopGraph(
        normalizedAddress,
        days,
        minUsdAmount,
        hops,
        ethPrice,
        tokenCache,
        currentBlock,
        centerData, // Pass already-fetched center data
      );
      const graphDuration = Date.now() - graphStartTime;
      console.log(
        `[WalletTracerService] Graph built in ${graphDuration}ms (${(graphDuration / 1000).toFixed(2)}s)`,
      );
      console.log(
        `[WalletTracerService] Graph contains ${graph.nodes.length} nodes and ${graph.edges.length} edges`,
      );
      response.graph = graph;
    } else {
      console.log('[WalletTracerService] Hops is 0, skipping graph building');
    }

    return response;
  }

  /**
   * Build multi-hop transaction graph
   */
  private async buildMultiHopGraph(
    centerAddress: string,
    days: number,
    minUsdAmount: number | undefined,
    maxHops: number,
    ethPrice: number | null,
    tokenCache: TokenCache,
    currentBlock: number,
    centerData?: {
      summary: {
        totalIncoming: string;
        totalIncomingUsd?: string;
        totalOutgoing: string;
        totalOutgoingUsd?: string;
        netFlow: string;
        netFlowUsd?: string;
        transactionCount: number;
      };
      transactions: TransactionFlow[];
      uniqueAddresses: {
        sentTo: string[];
        receivedFrom: string[];
      };
    },
  ): Promise<WalletGraph> {
    console.log(
      `[buildMultiHopGraph] Starting - center: ${centerAddress}, maxHops: ${maxHops}, days: ${days}`,
    );
    const visitedAddresses = new Set<string>([centerAddress.toLowerCase()]);
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>(); // Key: "from-to"
    const addressesByHop = new Map<number, Set<string>>();

    // Use provided center data or fetch it if not provided
    let finalCenterData;
    if (centerData) {
      console.log(
        `[buildMultiHopGraph] Using provided center node data (${centerData.transactions.length} transactions) - skipping duplicate fetch`,
      );
      finalCenterData = centerData;
    } else {
      // Trace center node (hop 0) - include ERC20 transactions for center wallet only
      console.log(`[buildMultiHopGraph] Tracing center node (hop 0): ${centerAddress}`);
      const centerStartTime = Date.now();
      finalCenterData = await this.traceSingleAddress(
        centerAddress,
        days,
        minUsdAmount,
        ethPrice,
        true, // includeERC20 = true for center wallet
        tokenCache,
        currentBlock,
      );
      const centerDuration = Date.now() - centerStartTime;
      console.log(
        `[buildMultiHopGraph] Center node traced in ${centerDuration}ms - ${finalCenterData.transactions.length} transactions, ${finalCenterData.uniqueAddresses.sentTo.length} sentTo, ${finalCenterData.uniqueAddresses.receivedFrom.length} receivedFrom`,
      );
    }

    // Add center node (will detect contract status later)
    nodes.set(centerAddress.toLowerCase(), {
      address: centerAddress.toLowerCase(),
      hop: 0,
    });

    // Get unique addresses from center node for hop 1 with their USD values
    const centerAddressValues = new Map<string, number>(); // address -> total USD value

    // Calculate USD value for each connected address from center node's transactions
    for (const tx of finalCenterData.transactions) {
      const otherAddress = tx.from === centerAddress.toLowerCase() ? tx.to : tx.from;
      if (!otherAddress || otherAddress === centerAddress.toLowerCase()) continue;

      const normalizedOtherAddr = otherAddress.toLowerCase();

      // Calculate USD value for this transaction
      let txUsdValue = 0;
      if (tx.valueUsd) {
        txUsdValue = this.parseUsdValue(tx.valueUsd);
      } else if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
        // For token transfers, use token USD value
        for (const token of tx.tokenTransfers) {
          if (token.valueUsd) {
            txUsdValue += this.parseUsdValue(token.valueUsd);
          }
        }
      }

      // Accumulate USD value for this address
      const currentValue = centerAddressValues.get(normalizedOtherAddr) || 0;
      centerAddressValues.set(normalizedOtherAddr, currentValue + txUsdValue);
    }

    // Sort by USD value and take top 10 for hop 1 (per-wallet decreasing limit)
    const sortedCenterAddresses = Array.from(centerAddressValues.entries()).sort(
      (a, b) => b[1] - a[1],
    ); // Sort by USD value descending

    const topCenterAddresses =
      sortedCenterAddresses.length > 10
        ? sortedCenterAddresses.slice(0, 10)
        : sortedCenterAddresses;

    const allCenterAddresses = new Set<string>(topCenterAddresses.map(([addr]) => addr));

    if (sortedCenterAddresses.length > 10) {
      console.log(
        `[buildMultiHopGraph] Limiting center node to top 10 addresses by USD value (from ${sortedCenterAddresses.length} total)`,
      );
      console.log(
        `[buildMultiHopGraph] Top address: ${topCenterAddresses[0][0]} with $${topCenterAddresses[0][1].toFixed(2)}`,
      );
    }

    // Build edges from center node's transactions ONLY to hop 1 addresses
    const centerTransactionsToHop1 = finalCenterData.transactions.filter((tx) => {
      const otherAddress = tx.from === centerAddress.toLowerCase() ? tx.to : tx.from;
      if (!otherAddress || otherAddress === centerAddress.toLowerCase()) return false;
      return allCenterAddresses.has(otherAddress.toLowerCase());
    });

    this.buildEdgesFromTransactions(centerTransactionsToHop1, centerAddress.toLowerCase(), edges);
    console.log(
      `[buildMultiHopGraph] Built ${edges.size} edges from center node to hop 1 addresses`,
    );

    addressesByHop.set(1, allCenterAddresses);
    console.log(`[buildMultiHopGraph] Hop 1 will trace ${allCenterAddresses.size} addresses`);

    // Process each hop level
    // Store transactions per address so we can build edges after filtering next hop addresses
    const transactionsByAddress = new Map<string, TransactionFlow[]>(); // address -> transactions

    for (let currentHop = 1; currentHop <= maxHops; currentHop++) {
      const addressesToTrace = addressesByHop.get(currentHop);
      if (!addressesToTrace || addressesToTrace.size === 0) {
        console.log(`[buildMultiHopGraph] Hop ${currentHop}: No addresses to trace, stopping`);
        break; // No more addresses to trace
      }

      console.log(`[buildMultiHopGraph] ===== Processing Hop ${currentHop} =====`);
      console.log(
        `[buildMultiHopGraph] Hop ${currentHop}: Tracing ${addressesToTrace.size} addresses`,
      );
      const hopStartTime = Date.now();
      // Track addresses with their total USD transaction values
      const nextHopAddressesWithValue = new Map<string, number>(); // address -> total USD value
      let tracedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      // Trace each address in the current hop
      for (const address of addressesToTrace) {
        const normalizedAddr = address.toLowerCase();

        // Skip if already visited (prevents cycles)
        if (visitedAddresses.has(normalizedAddr)) {
          skippedCount++;
          continue;
        }

        visitedAddresses.add(normalizedAddr);
        tracedCount++;
        console.log(
          `[buildMultiHopGraph] Hop ${currentHop}: [${tracedCount}/${addressesToTrace.size}] Tracing ${normalizedAddr}...`,
        );

        try {
          const addressTraceStart = Date.now();
          let addressValueMap: Map<string, number>;

          // Get addresses in current hop to allow same-level transactions (needed in both branches)
          const currentHopAddresses = addressesByHop.get(currentHop) || new Set<string>();

          // Determine if we need full transactions (for building edges to next hop)
          // Use full trace if: hop 1 (always) OR hop 2+ and there's a next hop to connect to
          const needsFullTrace = currentHop === 1 || currentHop < maxHops;

          if (needsFullTrace) {
            // Use full trace to build edges (hop 1 → hop 2, hop 2 → hop 3, etc.)
            const addressData = await this.traceSingleAddress(
              normalizedAddr,
              days,
              minUsdAmount,
              ethPrice,
              false, // includeERC20 = false for hop 1+ addresses
              tokenCache,
              currentBlock,
            );
            const addressTraceDuration = Date.now() - addressTraceStart;
            console.log(
              `[buildMultiHopGraph] Hop ${currentHop}: Traced ${normalizedAddr} in ${addressTraceDuration}ms - ${addressData.transactions.length} transactions`,
            );

            // Add node to graph (contract detection will be done later)
            nodes.set(normalizedAddr, {
              address: normalizedAddr,
              hop: currentHop,
            });

            // Store transactions for this address so we can build edges later (after filtering next hop)
            if (currentHop < maxHops) {
              transactionsByAddress.set(normalizedAddr, addressData.transactions);
            }

            // Collect addresses for next hop with their total USD transaction values FIRST
            // We need to know which addresses will be in the next hop before building edges
            // Calculate USD value for each connected address from transactions (per-wallet)
            addressValueMap = new Map<string, number>(); // address -> total USD value for THIS wallet

            for (const tx of addressData.transactions) {
              const otherAddress = tx.from === normalizedAddr ? tx.to : tx.from;
              if (!otherAddress || otherAddress === normalizedAddr) continue;

              const normalizedOtherAddr = otherAddress.toLowerCase();

              // Skip addresses that are in earlier hops (center or previous hops)
              // BUT allow addresses in the same hop (for same-level transactions)
              // We'll filter out same-hop addresses when building next hop, but allow edges
              const isInCurrentHop = currentHopAddresses.has(normalizedOtherAddr);
              const isInEarlierHops = visitedAddresses.has(normalizedOtherAddr) && !isInCurrentHop;

              if (isInEarlierHops) continue; // Skip center node and previous hop addresses

              // Calculate USD value for this transaction
              let txUsdValue = 0;
              if (tx.valueUsd) {
                txUsdValue = this.parseUsdValue(tx.valueUsd);
              } else if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
                // For token transfers, use token USD value
                for (const token of tx.tokenTransfers) {
                  if (token.valueUsd) {
                    txUsdValue += this.parseUsdValue(token.valueUsd);
                  }
                }
              }

              // Accumulate USD value for this address
              const currentValue = addressValueMap.get(normalizedOtherAddr) || 0;
              addressValueMap.set(normalizedOtherAddr, currentValue + txUsdValue);
            }
          } else {
            // Last hop: Use lightweight summary method (no transaction objects needed)
            const addressData = await this.traceSingleAddressSummary(
              normalizedAddr,
              days,
              minUsdAmount,
              ethPrice,
              currentBlock,
            );
            const addressTraceDuration = Date.now() - addressTraceStart;
            console.log(
              `[buildMultiHopGraph] Hop ${currentHop}: Traced ${normalizedAddr} in ${addressTraceDuration}ms (summary only) - ${addressData.summary.transactionCount} transactions`,
            );

            // Add node to graph (contract detection will be done later)
            nodes.set(normalizedAddr, {
              address: normalizedAddr,
              hop: currentHop,
            });

            // No edges to build (this is the last hop)
            addressValueMap = new Map<string, number>();
          }

          // Determine limit per wallet based on hop level (decreasing limits)
          let limitPerWallet: number;
          if (currentHop === 1) {
            limitPerWallet = 5; // Hop 1 → Hop 2: top 5 per wallet
          } else if (currentHop === 2) {
            limitPerWallet = 3; // Hop 2 → Hop 3: top 3 per wallet
          } else {
            limitPerWallet = 2; // Hop 3+ → next: top 2 per wallet
          }

          // Sort this wallet's addresses by USD value and take top N
          const sortedWalletAddresses = Array.from(addressValueMap.entries()).sort(
            (a, b) => b[1] - a[1],
          ); // Sort by USD value descending

          const topWalletAddresses =
            sortedWalletAddresses.length > limitPerWallet
              ? sortedWalletAddresses.slice(0, limitPerWallet)
              : sortedWalletAddresses;

          // Add top addresses from this wallet to nextHopAddressesWithValue
          // BUT exclude addresses that are in the current hop (same-level addresses)
          for (const [addr, value] of topWalletAddresses) {
            // Don't add same-level addresses to next hop (they're already in current hop)
            if (currentHopAddresses.has(addr)) continue;

            // If address already exists from another wallet, keep the higher value
            const existingValue = nextHopAddressesWithValue.get(addr) || 0;
            nextHopAddressesWithValue.set(addr, Math.max(existingValue, value));
          }

          if (sortedWalletAddresses.length > limitPerWallet) {
            console.log(
              `[buildMultiHopGraph] Hop ${currentHop}: Wallet ${normalizedAddr} - limiting to top ${limitPerWallet} addresses (from ${sortedWalletAddresses.length} total)`,
            );
          }
        } catch (error) {
          // If tracing fails for an address, continue with others
          errorCount++;
          console.error(
            `[buildMultiHopGraph] Hop ${currentHop}: ❌ Failed to trace ${normalizedAddr}:`,
            error.message,
          );
        }
      }

      const hopDuration = Date.now() - hopStartTime;
      console.log(
        `[buildMultiHopGraph] Hop ${currentHop} completed in ${hopDuration}ms (${(hopDuration / 1000).toFixed(2)}s)`,
      );
      console.log(
        `[buildMultiHopGraph] Hop ${currentHop} stats: traced=${tracedCount}, skipped=${skippedCount}, errors=${errorCount}`,
      );
      console.log(
        `[buildMultiHopGraph] Hop ${currentHop}: Found ${nextHopAddressesWithValue.size} unique addresses for next hop (after per-wallet filtering)`,
      );

      // Set addresses for next hop (if not the last hop)
      // No additional global limit needed - per-wallet limits already applied
      if (currentHop < maxHops) {
        // Final safety check: filter out any addresses that were visited during this hop
        // (This shouldn't happen due to earlier filtering, but provides extra safety)
        const finalAddressSet = new Set<string>();
        for (const addr of nextHopAddressesWithValue.keys()) {
          if (!visitedAddresses.has(addr)) {
            finalAddressSet.add(addr);
          }
        }

        if (finalAddressSet.size > 0) {
          // Find top address without sorting entire array (optimization for issue #16)
          let topAddress = '';
          let topValue = 0;
          for (const [addr, value] of nextHopAddressesWithValue.entries()) {
            if (!visitedAddresses.has(addr) && value > topValue) {
              topValue = value;
              topAddress = addr;
            }
          }
          console.log(
            `[buildMultiHopGraph] Hop ${currentHop} → ${currentHop + 1}: Top address is ${topAddress} with $${topValue.toFixed(2)}`,
          );
        }

        addressesByHop.set(currentHop + 1, finalAddressSet);

        // Now build edges from current hop
        // Include edges to: (1) next hop addresses, (2) same-level addresses (same hop)
        const currentHopAddressSet = addressesByHop.get(currentHop) || new Set<string>();
        console.log(
          `[buildMultiHopGraph] Building edges from hop ${currentHop} (to next hop: ${finalAddressSet.size}, same-level allowed)...`,
        );
        for (const addr of addressesToTrace) {
          const normalizedAddr = addr.toLowerCase();
          const addressTransactions = transactionsByAddress.get(normalizedAddr);
          if (addressTransactions) {
            // Filter transactions to include:
            // 1. Connections to next hop addresses (if not last hop)
            // 2. Connections to same-level addresses (same hop)
            const filteredTransactions = addressTransactions.filter((tx) => {
              const otherAddress = tx.from === normalizedAddr ? tx.to : tx.from;
              if (!otherAddress || otherAddress === normalizedAddr) return false;
              const normalizedOtherAddr = otherAddress.toLowerCase();

              // Include if it's going to next hop
              if (currentHop < maxHops && finalAddressSet.has(normalizedOtherAddr)) {
                return true;
              }

              // Include if it's going to same-level address (same hop)
              if (currentHopAddressSet.has(normalizedOtherAddr)) {
                return true;
              }

              return false;
            });

            // Build edges from filtered transactions
            this.buildEdgesFromTransactions(filteredTransactions, normalizedAddr, edges);
          }
        }
      }
    }

    console.log(
      `[buildMultiHopGraph] Graph building complete - ${nodes.size} nodes, ${edges.size} edges`,
    );

    // Ensure all addresses in edges are also in nodes
    // This should not happen now since we filter edges, but keep as safety check
    const missingNodes = new Set<string>();
    for (const edge of edges.values()) {
      if (!nodes.has(edge.from)) {
        missingNodes.add(edge.from);
        console.warn(`[buildMultiHopGraph] Edge from address ${edge.from} not found in nodes!`);
      }
      if (!nodes.has(edge.to)) {
        missingNodes.add(edge.to);
        console.warn(`[buildMultiHopGraph] Edge to address ${edge.to} not found in nodes!`);
      }
    }

    // Add missing nodes if any (shouldn't happen, but safety check)
    if (missingNodes.size > 0) {
      console.warn(
        `[buildMultiHopGraph] Adding ${missingNodes.size} missing nodes found in edges (this shouldn't happen!)...`,
      );
      for (const addr of missingNodes) {
        nodes.set(addr, {
          address: addr,
          hop: maxHops + 1, // Beyond our trace depth
        });
      }
    }

    // Detect contracts for all nodes (batch detection for efficiency)
    console.log(`[buildMultiHopGraph] Detecting contract status for ${nodes.size} nodes...`);
    const contractDetectionStart = Date.now();
    const nodeAddresses = Array.from(nodes.keys());

    // Batch detect contracts (with some parallelism but not too many concurrent requests)
    const batchSize = 10;
    for (let i = 0; i < nodeAddresses.length; i += batchSize) {
      const batch = nodeAddresses.slice(i, i + batchSize);
      const contractPromises = batch.map(async (addr) => {
        const isContract = await this.alchemyService.isContract(addr);
        const node = nodes.get(addr);
        if (node) {
          node.is_contract = isContract;
        }
      });
      await Promise.all(contractPromises);
    }

    const contractDetectionDuration = Date.now() - contractDetectionStart;
    console.log(
      `[buildMultiHopGraph] Contract detection completed in ${contractDetectionDuration}ms`,
    );

    return {
      centerNode: centerAddress.toLowerCase(),
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
    };
  }

  /**
   * Build edges from transactions - creates individual edge per transaction/asset
   * Each transaction can create multiple edges (one for ETH, one per token transfer)
   */
  private buildEdgesFromTransactions(
    transactions: TransactionFlow[],
    address: string,
    edges: Map<string, GraphEdge>,
  ): void {
    for (const tx of transactions) {
      const from = tx.from.toLowerCase();
      const to = tx.to.toLowerCase();

      // Create edge for ETH transfer if value > 0
      if (tx.value && parseFloat(tx.value) > 0) {
        const ethEdgeKey = `${tx.hash}-ETH`;
        if (!edges.has(ethEdgeKey)) {
          edges.set(ethEdgeKey, {
            from: from,
            to: to,
            tx_hash: tx.hash,
            timestamp: tx.timestamp || undefined,
            blockNumber: tx.blockNumber,
            asset: 'ETH',
            amount: tx.value,
            usd_value: tx.valueUsd || undefined,
          });
        }
      }

      // Create edges for token transfers
      if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
        for (const tokenTransfer of tx.tokenTransfers) {
          // Format asset as "contractAddress + symbol" or just "contractAddress" if no symbol
          const asset = tokenTransfer.tokenSymbol
            ? `${tokenTransfer.contractAddress} + ${tokenTransfer.tokenSymbol}`
            : tokenTransfer.contractAddress;

          const tokenEdgeKey = `${tx.hash}-${tokenTransfer.contractAddress}`;
          if (!edges.has(tokenEdgeKey)) {
            edges.set(tokenEdgeKey, {
              from: tokenTransfer.from.toLowerCase(),
              to: tokenTransfer.to.toLowerCase(),
              tx_hash: tx.hash,
              timestamp: tx.timestamp || undefined,
              blockNumber: tx.blockNumber,
              asset: asset,
              amount: tokenTransfer.value,
              usd_value: tokenTransfer.valueUsd || undefined,
            });
          }
        }
      }
    }
  }

  /**
   * Lightweight method to trace an address and return only summary data
   * Used for hop n+ addresses where we don't need full transaction objects
   * @returns Summary data and USD values per connected address (for next hop selection)
   */
  private async traceSingleAddressSummary(
    address: string,
    days: number,
    minUsdAmount: number | undefined,
    ethPrice: number | null,
    currentBlock: number,
  ): Promise<{
    summary: {
      totalIncoming: string;
      totalIncomingUsd?: string;
      totalOutgoing: string;
      totalOutgoingUsd?: string;
      netFlow: string;
      netFlowUsd?: string;
      transactionCount: number;
    };
    addressValues: Map<string, number>; // address -> total USD value
  }> {
    const normalizedAddress = address.toLowerCase();
    console.log(`[traceSingleAddressSummary] Tracing ${normalizedAddress}...`);

    // Calculate fromBlock based on days (using provided currentBlock)
    const { fromBlockNumber, fromBlock } = this.calculateFromBlock(currentBlock, days);

    // Get all asset transfers
    const transfersResult = await this.alchemyService.getAssetTransfers(
      normalizedAddress,
      fromBlock,
      undefined,
    );

    // Filter transfers by block number to ensure they're within the date range
    const filteredTransfers = transfersResult.transfers.filter((transfer) => {
      if (!transfer.blockNum) return false;
      const transferBlock =
        typeof transfer.blockNum === 'string' ? parseInt(transfer.blockNum, 16) : transfer.blockNum;
      return transferBlock >= fromBlockNumber;
    });

    console.log(
      `[traceSingleAddressSummary] ${normalizedAddress}: Filtered to ${filteredTransfers.length} transfers within block range (fromBlock: ${fromBlockNumber})`,
    );

    let totalIncoming = BigInt(0);
    let totalOutgoing = BigInt(0);
    let transactionCount = 0;
    const addressValues = new Map<string, number>(); // address -> total USD value

    // Process transfers without building transaction objects
    for (const transfer of filteredTransfers) {
      const isIncoming = transfer.to?.toLowerCase() === normalizedAddress;
      const isOutgoing = transfer.from?.toLowerCase() === normalizedAddress;

      if (!isIncoming && !isOutgoing) continue;

      // Calculate ETH value
      let value = BigInt(0);
      if (transfer.category === 'external') {
        const rawValue = transfer.rawContract?.value;
        if (rawValue) {
          value = BigInt(rawValue);
        } else if (transfer.value !== null && transfer.value !== undefined) {
          value = BigInt(Math.floor(transfer.value));
        }
      }

      // Apply filter
      if (transfer.category === 'external') {
        if (minUsdAmount !== undefined && minUsdAmount > 0 && ethPrice) {
          const ethValue = this.weiToEthNumber(value);
          const usdValue = ethValue * ethPrice;
          if (usdValue < minUsdAmount || value === 0n) {
            continue;
          }
        }
      }

      // Handle ERC20 transfers - only stablecoins for hop 2+
      let erc20Value = BigInt(0);
      let isStablecoin = false;

      if (transfer.category === 'erc20') {
        const contractAddress = transfer.rawContract?.address?.toLowerCase() || '';
        isStablecoin = this.isStablecoin(contractAddress);

        if (isStablecoin) {
          if (transfer.rawContract?.value) {
            erc20Value = BigInt(transfer.rawContract.value);
          } else if (transfer.value !== null && transfer.value !== undefined) {
            erc20Value = BigInt(Math.floor(transfer.value));
          }

          if (erc20Value > 0n) {
            const usdValue = this.calculateStablecoinUsdValue(erc20Value);

            // Apply USD filter for stablecoins - compare USD to USD
            if (minUsdAmount !== undefined && minUsdAmount > 0) {
              if (usdValue < minUsdAmount) {
                continue;
              }
            }
          }
        } else {
          // Skip non-stablecoin ERC20s for hop 2+
          continue;
        }
      }

      // Track totals
      if (transfer.category === 'external') {
        if (isIncoming) {
          totalIncoming = totalIncoming + value;
        } else {
          totalOutgoing = totalOutgoing + value;
        }
      } else if (transfer.category === 'erc20' && isStablecoin) {
        if (ethPrice) {
          const ethEquivalentWei = this.stablecoinToEthWei(erc20Value, ethPrice);
          if (isIncoming) {
            totalIncoming = totalIncoming + ethEquivalentWei;
          } else {
            totalOutgoing = totalOutgoing + ethEquivalentWei;
          }
        }
      }

      transactionCount++;

      // Calculate USD value for connected address tracking
      const otherAddress = isIncoming ? transfer.from : transfer.to;
      if (otherAddress && otherAddress.toLowerCase() !== normalizedAddress) {
        const normalizedOtherAddr = otherAddress.toLowerCase();
        let txUsdValue = 0;

        if (transfer.category === 'external' && value > 0n && ethPrice) {
          const ethValue = this.weiToEthNumber(value);
          txUsdValue = ethValue * ethPrice;
        } else if (transfer.category === 'erc20' && isStablecoin && erc20Value > 0n) {
          txUsdValue = this.calculateStablecoinUsdValue(erc20Value); // Always $1 for stablecoins
        }

        if (txUsdValue > 0) {
          const currentValue = addressValues.get(normalizedOtherAddr) || 0;
          addressValues.set(normalizedOtherAddr, currentValue + txUsdValue);
        }
      }
    }

    // Calculate net flow
    const netFlow = totalIncoming - totalOutgoing;

    // Calculate USD values
    const totalIncomingEth = this.weiToEthNumber(totalIncoming);
    const totalOutgoingEth = this.weiToEthNumber(totalOutgoing);
    const netFlowEth = this.weiToEthNumber(netFlow);

    const totalIncomingUsd = ethPrice ? `$${(totalIncomingEth * ethPrice).toFixed(2)}` : undefined;
    const totalOutgoingUsd = ethPrice ? `$${(totalOutgoingEth * ethPrice).toFixed(2)}` : undefined;
    const netFlowUsd = ethPrice ? `$${(netFlowEth * ethPrice).toFixed(2)}` : undefined;

    return {
      summary: {
        totalIncoming: this.alchemyService.formatEther(totalIncoming.toString()),
        totalIncomingUsd: totalIncomingUsd,
        totalOutgoing: this.alchemyService.formatEther(totalOutgoing.toString()),
        totalOutgoingUsd: totalOutgoingUsd,
        netFlow: this.alchemyService.formatEther(netFlow.toString()),
        netFlowUsd: netFlowUsd,
        transactionCount: transactionCount,
      },
      addressValues,
    };
  }

  /**
   * Trace a single address and return its transaction data
   * This is a helper method used for multi-hop tracing
   * @param includeERC20 - If true, include ERC20 token transactions (only for center wallet)
   * @param tokenCache - Cache for token metadata and prices (shared across hops)
   * @param currentBlock - Current block number (to avoid multiple API calls)
   */
  private async traceSingleAddress(
    address: string,
    days: number,
    minUsdAmount: number | undefined,
    ethPrice: number | null,
    includeERC20: boolean = false,
    tokenCache?: TokenCache,
    currentBlock?: number,
  ): Promise<{
    summary: {
      totalIncoming: string;
      totalIncomingUsd?: string;
      totalOutgoing: string;
      totalOutgoingUsd?: string;
      netFlow: string;
      netFlowUsd?: string;
      transactionCount: number;
    };
    transactions: TransactionFlow[];
    uniqueAddresses: {
      sentTo: string[];
      receivedFrom: string[];
    };
  }> {
    const normalizedAddress = address.toLowerCase();
    console.log(`[traceSingleAddress] Tracing ${normalizedAddress}...`);

    // Calculate fromBlock based on days
    // Use provided currentBlock if available, otherwise fetch it
    const blockNumber = currentBlock ?? (await this.alchemyService.getCurrentBlockNumber());
    const { fromBlockNumber, fromBlock } = this.calculateFromBlock(blockNumber, days);

    // Get all asset transfers
    const transfersStart = Date.now();
    const transfersResult = await this.alchemyService.getAssetTransfers(
      normalizedAddress,
      fromBlock,
      undefined, // No pageKey for single address tracing
    );
    const transfersDuration = Date.now() - transfersStart;
    console.log(
      `[traceSingleAddress] ${normalizedAddress}: Fetched ${transfersResult.transfers.length} transfers in ${transfersDuration}ms`,
    );

    // Filter transfers by block number to ensure they're within the date range
    const filteredTransfers = transfersResult.transfers.filter((transfer) => {
      if (!transfer.blockNum) return false;
      const transferBlock =
        typeof transfer.blockNum === 'string' ? parseInt(transfer.blockNum, 16) : transfer.blockNum;
      return transferBlock >= fromBlockNumber;
    });

    console.log(
      `[traceSingleAddress] ${normalizedAddress}: Filtered to ${filteredTransfers.length} transfers within block range (fromBlock: ${fromBlockNumber})`,
    );

    // Initialize token cache if not provided
    const cache: TokenCache = tokenCache || {
      metadata: new Map(),
      prices: new Map(),
    };

    const transactions: TransactionFlow[] = [];
    const sentToAddresses = new Set<string>();
    const receivedFromAddresses = new Set<string>();
    let totalIncoming = BigInt(0);
    let totalOutgoing = BigInt(0);

    // First pass: Collect unique non-stablecoin ERC20 token addresses
    const uniqueTokenAddresses = new Set<string>();
    if (includeERC20) {
      for (const transfer of filteredTransfers) {
        if (transfer.category === 'erc20') {
          const contractAddress = transfer.rawContract?.address?.toLowerCase() || '';
          if (contractAddress && !this.isStablecoin(contractAddress)) {
            uniqueTokenAddresses.add(contractAddress);
          }
        }
      }
    }

    // Batch fetch token metadata and prices
    if (uniqueTokenAddresses.size > 0) {
      await this.batchFetchTokenData(Array.from(uniqueTokenAddresses), cache);
    }

    console.log(
      `[traceSingleAddress] ${normalizedAddress}: Processing ${filteredTransfers.length} transfers...`,
    );
    const processingStart = Date.now();
    let processedCount = 0;
    const logInterval = 100; // Log every 100 transfers

    // Process each transfer (same logic as main traceWallet method)
    for (const transfer of filteredTransfers) {
      processedCount++;
      if (processedCount % logInterval === 0) {
        const elapsed = Date.now() - processingStart;
        console.log(
          `[traceSingleAddress] ${normalizedAddress}: Processed ${processedCount}/${filteredTransfers.length} transfers (${elapsed}ms elapsed)`,
        );
      }
      const isIncoming = transfer.to?.toLowerCase() === normalizedAddress;
      const isOutgoing = transfer.from?.toLowerCase() === normalizedAddress;

      if (!isIncoming && !isOutgoing) continue;

      // Calculate ETH value
      let value = BigInt(0);
      if (transfer.category === 'external') {
        const rawValue = transfer.rawContract?.value;
        if (rawValue) {
          value = BigInt(rawValue);
        } else if (transfer.value !== null && transfer.value !== undefined) {
          value = BigInt(Math.floor(transfer.value));
        }
      }

      // CRITICAL: Apply minimum USD amount filter FIRST - before ANY processing
      // This ensures addresses, transactions, and edges only include filtered data
      if (transfer.category === 'external') {
        if (minUsdAmount !== undefined && minUsdAmount > 0 && ethPrice) {
          const ethValue = this.weiToEthNumber(value);
          const usdValue = ethValue * ethPrice;
          if (usdValue < minUsdAmount || value === 0n) {
            continue; // Skip this transaction entirely - don't track addresses, don't count it, don't add to transactions
          }
        }
      }

      // Handle ERC20 transfers - USDC and USDT are included in filtering and hops
      let erc20Value = BigInt(0);
      let erc20ContractAddress = '';
      let isStablecoinToken = false;

      if (transfer.category === 'erc20') {
        erc20ContractAddress = transfer.rawContract?.address?.toLowerCase() || '';
        isStablecoinToken = this.isStablecoin(erc20ContractAddress);

        if (isStablecoinToken) {
          // Get raw value for USDC/USDT
          if (transfer.rawContract?.value) {
            erc20Value = BigInt(transfer.rawContract.value);
          } else if (transfer.value !== null && transfer.value !== undefined) {
            erc20Value = BigInt(Math.floor(transfer.value));
          }

          // USDC/USDT have 6 decimals, calculate USD value (always $1 per token)
          if (erc20Value > 0n) {
            const usdValue = this.calculateStablecoinUsdValue(erc20Value);

            // Apply USD filter for stablecoins - compare USD to USD
            if (minUsdAmount !== undefined && minUsdAmount > 0) {
              if (usdValue < minUsdAmount) {
                continue; // Skip if below threshold
              }
            }
          }
        } else {
          // For non-stablecoin ERC20s, only include if includeERC20 is true (center wallet)
          if (!includeERC20) {
            continue; // Skip non-stablecoin ERC20s for hop addresses
          }
        }
      }

      // Track unique addresses from ETH, USDC, and USDT transactions that passed the filter
      if (
        transfer.category === 'external' ||
        (transfer.category === 'erc20' && isStablecoinToken)
      ) {
        if (isIncoming && transfer.from) {
          const fromAddr = transfer.from.toLowerCase();
          if (fromAddr && fromAddr !== normalizedAddress) {
            receivedFromAddresses.add(fromAddr);
          }
        }
        if (isOutgoing && transfer.to) {
          const toAddr = transfer.to.toLowerCase();
          if (toAddr && toAddr !== normalizedAddress) {
            sentToAddresses.add(toAddr);
          }
        }
      }

      // Track ETH and stablecoin values
      if (transfer.category === 'external') {
        if (isIncoming) {
          totalIncoming = totalIncoming + value;
        } else {
          totalOutgoing = totalOutgoing + value;
        }
      } else if (transfer.category === 'erc20' && isStablecoinToken) {
        // For stablecoins, convert to ETH equivalent for summary
        if (ethPrice) {
          const ethEquivalentWei = this.stablecoinToEthWei(erc20Value, ethPrice);
          if (isIncoming) {
            totalIncoming = totalIncoming + ethEquivalentWei;
          } else {
            totalOutgoing = totalOutgoing + ethEquivalentWei;
          }
        }
      }

      // Parse block number
      let blockNumber = 0;
      if (transfer.blockNum) {
        blockNumber =
          typeof transfer.blockNum === 'string'
            ? parseInt(transfer.blockNum, 16)
            : transfer.blockNum;
      }

      // Extract timestamp from metadata if available
      let timestamp = 0;
      if (transfer.metadata?.blockTimestamp) {
        timestamp = new Date(transfer.metadata.blockTimestamp).getTime();
      }

      // Calculate USD value
      let valueUsd: string | undefined;
      if (transfer.category === 'external' && value > 0n && ethPrice) {
        const ethValue = this.weiToEthNumber(value);
        const usdValue = ethValue * ethPrice;
        valueUsd = `$${usdValue.toFixed(2)}`;
      }

      // Build transaction flow object
      const transactionFlow: TransactionFlow = {
        hash: transfer.hash,
        from: transfer.from?.toLowerCase() || '',
        to: transfer.to?.toLowerCase() || '',
        value: value > 0n ? this.alchemyService.formatEther(value.toString()) : '0',
        valueUsd: valueUsd,
        timestamp: timestamp,
        blockNumber: blockNumber,
        type: isIncoming ? 'incoming' : 'outgoing',
      };

      // Handle ERC20 token transfers
      if (transfer.category === 'erc20') {
        // Reuse the contract address and stablecoin check from early filtering
        const contractAddress =
          erc20ContractAddress || transfer.rawContract?.address?.toLowerCase() || '';

        if (!contractAddress) {
          continue;
        }

        // Reuse the stablecoin check result from early filtering (line 1134)
        // No need to check again - we already have isStablecoinToken variable

        if (isStablecoinToken) {
          // USDC/USDT: Process like ETH - include in filtering and hops
          const rawValue = this.getRawValueFromTransfer(transfer);

          if (rawValue !== '0' && BigInt(rawValue) > 0n) {
            const tokenSymbol = this.getStablecoinSymbol(contractAddress);
            const valueBigInt = BigInt(rawValue);
            const formattedValue = Number(valueBigInt) / Number(this.STABLECOIN_DIVISOR);

            const tokenTransfer: TokenTransfer = {
              contractAddress: contractAddress,
              tokenName: tokenSymbol === 'USDC' ? 'USD Coin' : 'Tether USD',
              tokenSymbol: tokenSymbol || 'UNKNOWN',
              decimals: this.STABLECOIN_DECIMALS,
              value: formattedValue.toFixed(6).replace(/\.?0+$/, ''),
              valueUsd: `$${formattedValue.toFixed(2)}`, // USDC/USDT are always $1
              tokenPrice: 1, // Always $1
              from: transfer.from?.toLowerCase() || '',
              to: transfer.to?.toLowerCase() || '',
            };

            transactionFlow.tokenTransfers = [tokenTransfer];
            // Set USD value for the transaction flow (for stablecoins)
            transactionFlow.valueUsd = `$${formattedValue.toFixed(2)}`;
          }
        } else {
          // Other ERC20 tokens: Only include if includeERC20 is true (center wallet)
          const rawValue = this.getRawValueFromTransfer(transfer);

          if (rawValue !== '0' && BigInt(rawValue) > 0n) {
            const tokenTransfer: TokenTransfer = {
              contractAddress: contractAddress,
              value: rawValue,
              from: transfer.from?.toLowerCase() || '',
              to: transfer.to?.toLowerCase() || '',
            };

            // Use cached token metadata and prices for other ERC20 tokens
            if (includeERC20) {
              // contractAddress is already normalized, no need to normalize again
              const metadata = cache.metadata.get(contractAddress);

              if (metadata) {
                tokenTransfer.tokenName = metadata.name;
                tokenTransfer.tokenSymbol = metadata.symbol;
                tokenTransfer.decimals = metadata.decimals;

                // Format the value using token decimals
                let formattedValue = 0;
                if (metadata.decimals !== undefined && metadata.decimals !== null) {
                  const valueBigInt = BigInt(rawValue);
                  const divisor = BigInt(10 ** metadata.decimals);
                  formattedValue = Number(valueBigInt) / Number(divisor);
                  tokenTransfer.value = formattedValue.toFixed(6).replace(/\.?0+$/, '');
                }

                // Get token price from cache
                const tokenPrice = cache.prices.get(contractAddress);
                if (tokenPrice && formattedValue > 0) {
                  tokenTransfer.tokenPrice = tokenPrice;
                  const usdValue = formattedValue * tokenPrice;
                  tokenTransfer.valueUsd = `$${usdValue.toFixed(2)}`;
                }
              }
            }

            transactionFlow.tokenTransfers = [tokenTransfer];
          }
        }
      }

      // Add transaction to list - only transactions that passed the filter reach here
      if (transfer.category === 'external') {
        transactions.push(transactionFlow);
      } else if (transfer.category === 'erc20') {
        // Reuse the stablecoin check result from early filtering (line 1134)
        // No need to check again - we already have isStablecoinToken variable

        if (isStablecoinToken) {
          // Stablecoins are always included - they're used for filtering and hops
          if (transactionFlow.tokenTransfers && transactionFlow.tokenTransfers.length > 0) {
            transactions.push(transactionFlow);
          }
        } else {
          // Other ERC20 tokens: Only include if includeERC20 is true (center wallet only)
          if (
            includeERC20 &&
            transactionFlow.tokenTransfers &&
            transactionFlow.tokenTransfers.length > 0
          ) {
            transactions.push(transactionFlow);
          }
        }
      }
    }

    const processingDuration = Date.now() - processingStart;
    console.log(
      `[traceSingleAddress] ${normalizedAddress}: Finished processing ${processedCount} transfers in ${processingDuration}ms`,
    );

    // Sort transactions by block number
    transactions.sort((a, b) => b.blockNumber - a.blockNumber);

    // Calculate net flow
    const netFlow = totalIncoming - totalOutgoing;

    // Calculate USD values
    const totalIncomingEth = this.weiToEthNumber(totalIncoming);
    const totalOutgoingEth = this.weiToEthNumber(totalOutgoing);
    const netFlowEth = this.weiToEthNumber(netFlow);

    const totalIncomingUsd = ethPrice ? `$${(totalIncomingEth * ethPrice).toFixed(2)}` : undefined;
    const totalOutgoingUsd = ethPrice ? `$${(totalOutgoingEth * ethPrice).toFixed(2)}` : undefined;
    const netFlowUsd = ethPrice ? `$${(netFlowEth * ethPrice).toFixed(2)}` : undefined;

    // Transaction count - all transactions in array are already filtered
    const filteredTransactionCount = transactions.length;

    console.log(
      `[traceSingleAddress] ${normalizedAddress} summary: ${filteredTransactionCount} filtered transactions (minUsdAmount: ${minUsdAmount}), sentTo: ${sentToAddresses.size}, receivedFrom: ${receivedFromAddresses.size}`,
    );

    return {
      summary: {
        totalIncoming: this.alchemyService.formatEther(totalIncoming.toString()),
        totalIncomingUsd: totalIncomingUsd,
        totalOutgoing: this.alchemyService.formatEther(totalOutgoing.toString()),
        totalOutgoingUsd: totalOutgoingUsd,
        netFlow: this.alchemyService.formatEther(netFlow.toString()),
        netFlowUsd: netFlowUsd,
        transactionCount: filteredTransactionCount, // Only filtered transactions
      },
      transactions,
      uniqueAddresses: {
        sentTo: Array.from(sentToAddresses),
        receivedFrom: Array.from(receivedFromAddresses),
      },
    };
  }

  /**
   * Export graph to graph.json file
   * Saves the graph structure to a JSON file in the project root
   */
  async exportGraphToFile(graph: WalletGraph, outputPath?: string): Promise<string> {
    try {
      // Default to project root if no path specified
      const filePath = outputPath || join(process.cwd(), 'graph.json');

      // Convert graph to JSON with pretty formatting
      const graphJson = JSON.stringify(graph, null, 2);

      // Write to file
      await writeFile(filePath, graphJson, 'utf-8');

      console.log(`[WalletTracerService] Graph exported to: ${filePath}`);
      console.log(
        `[WalletTracerService] Graph contains ${graph.nodes.length} nodes and ${graph.edges.length} edges`,
      );

      return filePath;
    } catch (error: any) {
      console.error(`[WalletTracerService] Failed to export graph to file:`, error.message);
      throw new Error(`Failed to export graph: ${error.message}`);
    }
  }

  /**
   * Classify wallet type based on transaction patterns, balance, and contract status
   */
  private async classifyWalletType(
    address: string,
    summary: WalletTraceResponse['summary'],
    graph?: WalletGraph,
  ): Promise<{ type: string; balance: number; details: string }> {
    // Get balance
    const balance = await this.alchemyService.getEthBalance(address);

    // Check if it's a contract (from graph first, then Alchemy if not found)
    const centerNode = graph?.nodes.find((n) => n.address.toLowerCase() === address.toLowerCase());
    let isContract = centerNode?.is_contract;
    if (isContract === undefined) {
      // Not in graph, check directly with Alchemy
      isContract = await this.alchemyService.isContract(address);
    }

    // Parse USD values for comparison
    const parseUsdValue = (value: string): number => {
      if (!value) return 0;
      const cleaned = value.replace(/[$,]/g, '');
      return parseFloat(cleaned) || 0;
    };

    const totalIncomingUsd = parseUsdValue(summary.totalIncomingUsd || '0');
    const totalOutgoingUsd = parseUsdValue(summary.totalOutgoingUsd || '0');
    const netFlowUsd = parseUsdValue(summary.netFlowUsd || '0');

    // Calculate transaction ratio
    const incomingCount = summary.uniqueAddresses.receivedFrom.length;
    const outgoingCount = summary.uniqueAddresses.sentTo.length;
    const totalTransactions = summary.transactionCount;

    // Classification logic
    let type = 'Unknown';
    let details = '';

    // High balance threshold (100 ETH = ~$300k+ at current prices)
    const HIGH_BALANCE_THRESHOLD = 100;
    const VERY_HIGH_BALANCE_THRESHOLD = 1000;

    if (isContract) {
      if (balance >= VERY_HIGH_BALANCE_THRESHOLD) {
        type = 'Protocol/Institutional Contract';
        details = `High-value contract (${balance.toFixed(4)} ETH)`;
      } else if (balance >= HIGH_BALANCE_THRESHOLD) {
        type = 'Institutional Contract';
        details = `Contract with significant balance (${balance.toFixed(4)} ETH)`;
      } else if (totalIncomingUsd > totalOutgoingUsd * 1.5) {
        type = 'Treasury Contract';
        details = 'Contract receiving more than it sends (treasury pattern)';
      } else {
        type = 'Smart Contract';
        details = 'Smart contract address';
      }
    } else {
      // EOA classification
      if (balance >= VERY_HIGH_BALANCE_THRESHOLD) {
        type = 'Protocol/Institutional Wallet';
        details = `High-value wallet (${balance.toFixed(4)} ETH)`;
      } else if (balance >= HIGH_BALANCE_THRESHOLD) {
        type = 'Institutional Wallet';
        details = `Wallet with significant balance (${balance.toFixed(4)} ETH)`;
      } else if (totalIncomingUsd > totalOutgoingUsd * 1.5 && incomingCount > outgoingCount) {
        type = 'Funding Wallet';
        details = 'Receives significantly more than it sends (funding pattern)';
      } else if (totalOutgoingUsd > totalIncomingUsd * 1.5 && outgoingCount > incomingCount) {
        type = 'Distribution Wallet';
        details = 'Sends significantly more than it receives (distribution pattern)';
      } else if (Math.abs(netFlowUsd) < totalIncomingUsd * 0.1 && totalTransactions > 10) {
        type = 'Active Trading Wallet';
        details = 'High activity with balanced flow (trading pattern)';
      } else {
        type = 'Personal Wallet';
        details = 'Standard wallet address';
      }
    }

    return { type, balance, details };
  }

  /**
   * Export summary to summary.md file
   * Creates a markdown summary with top 10 inflow/outflow sources and account types
   */
  async exportSummaryToFile(
    response: WalletTraceResponse,
    graph?: WalletGraph,
    outputPath?: string,
  ): Promise<string> {
    try {
      // Default to project root if no path specified
      const filePath = outputPath || join(process.cwd(), 'summary.md');

      // Classify the center wallet
      const walletClassification = await this.classifyWalletType(
        response.walletAddress,
        response.summary,
        graph,
      );

      // Create a map of address -> is_contract from graph nodes
      const addressToContractMap = new Map<string, boolean>();
      if (graph) {
        for (const node of graph.nodes) {
          addressToContractMap.set(node.address.toLowerCase(), node.is_contract || false);
        }
      }

      // Helper to get account type
      const getAccountType = (address: string): string => {
        const isContract = addressToContractMap.get(address.toLowerCase());
        if (isContract === true) return 'Contract';
        if (isContract === false) return 'EOA';
        return 'Unknown'; // If not in graph, we don't know
      };

      // Build markdown content
      const mdContent = `# Wallet Trace Summary

**Wallet Address:** \`${response.walletAddress}\`

**Wallet Type:** **${walletClassification.type}**
- ${walletClassification.details}
- **Current Balance:** ${walletClassification.balance.toFixed(6)} ETH

**Generated:** ${new Date().toISOString()}

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Total Incoming | ${response.summary.totalIncoming} ETH ${response.summary.totalIncomingUsd ? `(${response.summary.totalIncomingUsd})` : ''} |
| Total Outgoing | ${response.summary.totalOutgoing} ETH ${response.summary.totalOutgoingUsd ? `(${response.summary.totalOutgoingUsd})` : ''} |
| Net Flow | ${response.summary.netFlow} ETH ${response.summary.netFlowUsd ? `(${response.summary.netFlowUsd})` : ''} |
| Transaction Count | ${response.summary.transactionCount} |
| Unique Addresses (Sent To) | ${response.summary.uniqueAddresses.sentTo.length} |
| Unique Addresses (Received From) | ${response.summary.uniqueAddresses.receivedFrom.length} |

---

## Top 10 Inflow Sources (by USD Value)

${
  response.summary.topInflowSources && response.summary.topInflowSources.length > 0
    ? `| Rank | Address | Account Type | Total USD Value | Transactions |
|------|---------|--------------|-----------------|--------------|
${response.summary.topInflowSources
  .map(
    (source, index) =>
      `| ${index + 1} | \`${source.address}\` | ${getAccountType(source.address)} | ${source.totalValueUsd} | ${source.transactionCount} |`,
  )
  .join('\n')}`
    : '*No inflow sources found*'
}

---

## Top 10 Outflow Sources (by USD Value)

${
  response.summary.topOutflowSources && response.summary.topOutflowSources.length > 0
    ? `| Rank | Address | Account Type | Total USD Value | Transactions |
|------|---------|--------------|-----------------|--------------|
${response.summary.topOutflowSources
  .map(
    (source, index) =>
      `| ${index + 1} | \`${source.address}\` | ${getAccountType(source.address)} | ${source.totalValueUsd} | ${source.transactionCount} |`,
  )
  .join('\n')}`
    : '*No outflow sources found*'
}

---

## Graph Information

${
  graph
    ? `- **Center Node:** \`${graph.centerNode}\`
- **Total Nodes:** ${graph.nodes.length}
- **Total Edges:** ${graph.edges.length}
- **Contract Nodes:** ${graph.nodes.filter((n) => n.is_contract).length}
- **EOA Nodes:** ${graph.nodes.filter((n) => !n.is_contract).length}`
    : '*Graph not generated*'
}

---

## Notes

- **Account Types:**
  - **EOA**: Externally Owned Account (regular wallet)
  - **Contract**: Smart Contract address
  - **Unknown**: Address not found in graph (may not have been traced)

- All USD values are calculated using current ETH price at the time of trace.
- Transaction counts reflect only transactions that met the minimum USD threshold (if specified).
${
  response.truncated && response.truncationWarning
    ? `\n\n## ⚠️ Truncation Warning\n\n${response.truncationWarning}`
    : ''
}
`;

      // Write to file
      await writeFile(filePath, mdContent, 'utf-8');

      console.log(`[WalletTracerService] Summary exported to: ${filePath}`);

      return filePath;
    } catch (error: any) {
      console.error(`[WalletTracerService] Failed to export summary to file:`, error.message);
      throw new Error(`Failed to export summary: ${error.message}`);
    }
  }
}
