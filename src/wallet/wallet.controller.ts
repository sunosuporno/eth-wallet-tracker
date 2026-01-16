import { Controller, Get, Query, HttpException, HttpStatus } from '@nestjs/common';
import { WalletTracerService } from './wallet-tracer.service';
import { TraceWalletDto } from './dto/trace-wallet.dto';
import { WalletTraceResponse } from './dto/wallet-trace-response.dto';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletTracerService: WalletTracerService) {}

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

  /**
   * Basic Ethereum address validation
   */
  private isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }
}
