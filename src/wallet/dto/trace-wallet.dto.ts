import { IsString, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class TraceWalletDto {
  @IsString()
  address: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(365)
  days?: number = 30;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minEthAmount?: number; // Minimum ETH amount to filter transactions

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minUsdAmount?: number; // Minimum USD amount to filter transactions (converted to ETH by backend)

  @IsOptional()
  @IsString()
  pageKey?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(3)
  hops?: number = 2; // Number of hops to trace (1-3 only)
}
