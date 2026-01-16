import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WalletController } from './wallet.controller';
import { WalletTracerService } from './wallet-tracer.service';
import { AlchemyService } from './alchemy.service';
import { CoinGeckoService } from './coingecko.service';

@Module({
  imports: [HttpModule],
  controllers: [WalletController],
  providers: [WalletTracerService, AlchemyService, CoinGeckoService],
  exports: [WalletTracerService, AlchemyService, CoinGeckoService],
})
export class WalletModule {}
