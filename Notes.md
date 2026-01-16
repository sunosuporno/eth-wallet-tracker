### Notes on limitations, future plans, etc.

#### Limitations/Design Decisions

- The tool enforces an upper bound on the number of transactions processed per wallet to prevent unbounded runtime and RPC exhaustion when using public data providers.
- Public Ethereum APIs do not support server-side filtering or ordering of transfers by USD value.
  As a result, the tool applies min_usd filtering client-side after fetching transfers within a bounded time window, making the time range the primary control on runtime.
- For the same reason as above, the tool has enforced a maximum number of wallets that can be traced at each hop level. Starting at 10 wallets for the first hop, 5 for the second, and 3 for the third. These wallets are ordered by USD value of transfers.
- Requests are currently executed sequentially to avoid overwhelming public RPC endpoints.
  In a production setting, this would be extended with explicit rate limiting and controlled parallelism to support concurrent users.

### Future Plans

- Add rate limiting to prevent API throttling
- Add checkpoint/resume functionality for long-running traces
- Add support for other token types eg ERC721, ERC1155
- Add support for approvals - to be done by tracking the ERC-20 `Approval(owner, spender, value)` event logs for the concerned token
