# ETH Wallet Tracer

A NestJS-based Ethereum wallet tracer that helps investigators understand where value came from and where it went for any given wallet address on Ethereum mainnet.

**✨ Most functionality is accessible through the integrated web frontend!** Simply start the server and open the web interface in your browser.

## Features

- 🌐 **Integrated Web Interface**: Beautiful, modern UI for tracing wallets without writing code
- 🔍 **Complete Transaction History**: Fetches all transactions (ETH and tokens) for a wallet
- 📊 **Value Flow Analysis**: Tracks incoming and outgoing value flows with USD conversions
- 🎯 **Investigator-Friendly**: Clear summary of wallet activity with unique addresses
- 🔗 **Token Support**: Tracks ERC20, ERC721, and ERC1155 token transfers
- 📈 **Interactive Network Graph**: Visualize transaction relationships with an interactive graph
- 📋 **Top Sources Analysis**: See top 10 inflow and outflow sources by USD value
- 📄 **Pagination**: Supports pagination for wallets with many transactions

## Tech Stack

- **NestJS**: Modern Node.js framework
- **Alchemy SDK**: Ethereum blockchain data provider
- **Ethers.js**: Ethereum utilities
- **HTML/CSS/JavaScript**: Integrated frontend with interactive visualizations

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Alchemy API key ([Get one here](https://www.alchemy.com/))

## Setup

1. **Install dependencies**:

   ```bash
   npm install
   ```

2. **Configure environment variables**:
   Create a `.env` file in the root directory:

   ```env
   ALCHEMY_API_KEY=your_alchemy_api_key_here
   COIN_GECKO_API_KEY=your_coingecko_api_key_here
   ```

3. **Start the development server**:

   ```bash
   npm run start:dev
   ```

4. **Access the application**:
   - **Web Interface**: Open `http://localhost:3000/index.html` in your browser
   - **API**: Available at `http://localhost:3000`

## Web Interface

The integrated frontend provides a user-friendly way to trace wallets without using the API directly. Features include:

- **Search Form**: Enter wallet address, configure trace parameters (days, minimum USD value, hops)
- **Summary Dashboard**: View total incoming/outgoing values, net flow, and transaction counts
- **Top Sources Tables**: See the top 10 addresses by inflow and outflow value
- **Connected Addresses**: Browse all unique addresses that sent to or received from the wallet
- **Transaction List**: Detailed view of all transactions with token information
- **Interactive Network Graph**: Visualize transaction relationships with:
  - Color-coded nodes by hop level
  - Directional arrows showing value flow
  - Interactive tooltips and node selection
  - Zoom and pan controls

Simply navigate to `http://localhost:3000/index.html` after starting the server to use the web interface.

## API Endpoints

### Trace Wallet

```
GET /wallet/trace?address=0x...&limit=100&pageKey=...
```

**Query Parameters:**

- `address` (required): Ethereum wallet address
- `limit` (optional): Number of transactions to return (default: 100, max: 1000)
- `pageKey` (optional): Pagination key for next page

**Response:**

```json
{
  "walletAddress": "0x...",
  "summary": {
    "totalIncoming": "10.5",
    "totalOutgoing": "5.2",
    "netFlow": "5.3",
    "transactionCount": 50,
    "uniqueAddresses": {
      "sentTo": ["0x...", "0x..."],
      "receivedFrom": ["0x...", "0x..."]
    }
  },
  "transactions": [
    {
      "hash": "0x...",
      "from": "0x...",
      "to": "0x...",
      "value": "1.5",
      "timestamp": 1234567890,
      "blockNumber": 18000000,
      "type": "incoming",
      "tokenTransfers": [...]
    }
  ],
  "pageKey": "..."
}
```

## Usage

### Web Interface (Recommended)

1. Start the server: `npm run start:dev`
2. Open `http://localhost:3000/index.html` in your browser
3. Enter a wallet address and configure trace parameters
4. Click "Trace Wallet" to see results

### API Usage

You can also use the API directly via curl or any HTTP client:

```bash
# Trace a wallet
curl "http://localhost:3000/wallet/trace?address=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb5&limit=50"

# Get transaction details
curl "http://localhost:3000/wallet/transaction/0x..."
```

## Project Structure

```
src/
├── main.ts                 # Application entry point
├── app.module.ts          # Root module
└── wallet/
    ├── wallet.module.ts   # Wallet module
    ├── wallet.controller.ts # API endpoints
    ├── wallet-tracer.service.ts # Business logic
    ├── alchemy.service.ts  # Alchemy SDK wrapper
    ├── coingecko.service.ts # CoinGecko API wrapper for price data
    └── dto/
        ├── trace-wallet.dto.ts
        └── wallet-trace-response.dto.ts
public/
└── index.html             # Integrated web frontend
```

## Development

```bash
# Development mode with hot reload
npm run start:dev

# Build for production
npm run build

# Start production server
npm run start:prod
```

## License

MIT
