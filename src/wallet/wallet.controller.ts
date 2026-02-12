import { Controller, Get, Query, HttpException, HttpStatus, Res } from '@nestjs/common';
import { WalletTracerService } from './wallet-tracer.service';
import { AlchemyService } from './alchemy.service';
import { EtherscanService } from './etherscan.service';
import { TraceWalletDto } from './dto/trace-wallet.dto';
import { WalletTraceResponse } from './dto/wallet-trace-response.dto';
import { Response } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletTracerService: WalletTracerService,
    private readonly alchemyService: AlchemyService,
    private readonly etherscanService: EtherscanService,
  ) {}

  @Get('trace')
  async traceWallet(@Query() query: TraceWalletDto): Promise<WalletTraceResponse> {
    const startTime = Date.now();
    console.log('=== TRACE WALLET REQUEST ===');
    console.log('Address:', query.address);
    console.log('Days:', query.days);
    console.log('Hops:', query.hops);
    console.log('MinEthAmount:', query.minEthAmount);
    console.log('MinUsdAmount:', query.minUsdAmount);
    console.log('PageKey:', query.pageKey ? 'provided' : 'none');
    console.log('Timestamp:', new Date().toISOString());

    try {
      // Validate Ethereum address format
      if (!this.isValidEthereumAddress(query.address)) {
        console.log('❌ Invalid address format');
        throw new HttpException('Invalid Ethereum address format', HttpStatus.BAD_REQUEST);
      }

      console.log('✅ Address validated, starting trace...');
      const result = await this.walletTracerService.traceWallet(
        query.address,
        query.days,
        query.pageKey,
        query.minEthAmount,
        query.minUsdAmount,
        query.hops,
      );

      const duration = Date.now() - startTime;
      console.log(`✅ Trace completed in ${duration}ms (${(duration / 1000).toFixed(2)}s)`);
      console.log('Transaction count:', result.summary.transactionCount);
      console.log('Graph nodes:', result.graph?.nodes.length || 0);
      console.log('Graph edges:', result.graph?.edges.length || 0);

      // Export graph to graph.json file if graph exists
      if (result.graph) {
        try {
          const graphFilePath = await this.walletTracerService.exportGraphToFile(result.graph);
          console.log(`📄 Graph exported to: ${graphFilePath}`);
        } catch (error: any) {
          console.error(`⚠️  Failed to export graph to file:`, error.message);
          // Don't fail the request if file export fails
        }
      }

      // Export summary to summary.md file
      try {
        const summaryFilePath = await this.walletTracerService.exportSummaryToFile(
          result,
          result.graph,
        );
        console.log(`📄 Summary exported to: ${summaryFilePath}`);
      } catch (error: any) {
        console.error(`⚠️  Failed to export summary to file:`, error.message);
        // Don't fail the request if file export fails
      }

      console.log('=== END TRACE ===\n');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ Trace failed after ${duration}ms:`, error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to trace wallet: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('balances')
  async getWalletBalances(@Query('address') address: string): Promise<any> {
    try {
      // Validate Ethereum address format
      if (!this.isValidEthereumAddress(address)) {
        throw new HttpException('Invalid Ethereum address format', HttpStatus.BAD_REQUEST);
      }

      console.log(`[WalletController] Fetching balances for address: ${address}`);
      const result = await this.alchemyService.getTokenBalances(address, ['eth-mainnet']);

      // Fetch metadata and verification status for each ERC-20 token
      if (result.tokens && Array.isArray(result.tokens)) {
        console.log(`[WalletController] Fetching metadata for ${result.tokens.length} tokens`);

        // Separate native tokens from ERC-20 tokens
        const nativeTokens = result.tokens.filter((token: any) => !token.tokenAddress);
        const erc20Tokens = result.tokens.filter((token: any) => token.tokenAddress);

        // Fetch metadata for ERC-20 tokens
        const tokensWithMetadata = await Promise.all(
          erc20Tokens.map(async (token: any) => {
            const tokenAddress = token.tokenAddress;
            let enrichedToken = { ...token };

            // Fetch token metadata from Alchemy
            try {
              const metadata = await this.alchemyService.getTokenMetadata(tokenAddress);
              if (metadata) {
                enrichedToken = {
                  ...enrichedToken,
                  tokenName: metadata.name || null,
                  tokenSymbol: metadata.symbol || null,
                  decimals: metadata.decimals !== undefined ? metadata.decimals : null,
                };
              }
            } catch (error: any) {
              console.warn(
                `[WalletController] Failed to fetch metadata for token ${tokenAddress}:`,
                error.message,
              );
            }

            // Check contract verification status on Etherscan
            try {
              const verificationStatus =
                await this.etherscanService.checkContractVerification(tokenAddress);
              enrichedToken = {
                ...enrichedToken,
                isContractVerified: verificationStatus.isVerified,
                contractName: verificationStatus.contractName,
                isSimilarMatch: verificationStatus.isSimilarMatch,
                similarMatchAddress: verificationStatus.similarMatchAddress,
              };
            } catch (error: any) {
              console.warn(
                `[WalletController] Failed to check verification for token ${tokenAddress}:`,
                error.message,
              );
              // Default to unverified if check fails
              enrichedToken = {
                ...enrichedToken,
                isContractVerified: false,
                contractName: null,
                isSimilarMatch: false,
                similarMatchAddress: null,
              };
            }

            return enrichedToken;
          }),
        );

        // Combine native tokens with enriched ERC-20 tokens
        const allTokens = [...nativeTokens, ...tokensWithMetadata];

        return {
          ...result,
          tokens: allTokens,
        };
      }

      return result;
    } catch (error) {
      console.error(`[WalletController] Error fetching balances:`, error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to fetch wallet balances: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('graph')
  async getGraph(@Res() res: Response): Promise<void> {
    try {
      const graphFilePath = join(process.cwd(), 'graph.json');
      const graphData = await readFile(graphFilePath, 'utf-8');
      res.setHeader('Content-Type', 'application/json');
      res.send(graphData);
    } catch (error: any) {
      console.error(`[WalletController] Error reading graph.json:`, error);
      if (error.code === 'ENOENT') {
        throw new HttpException('graph.json file not found', HttpStatus.NOT_FOUND);
      }
      throw new HttpException(
        `Failed to read graph.json: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Basic Ethereum address validation
   */
  private isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }
}
