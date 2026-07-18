# Interface Contract: `@ton/mcp` Server Tools

This document defines the interface schemas exposed by the Model Context Protocol (MCP) server for trading operations.

---

## 1. Tool: `get_wallet_balance`

Returns the TON and Jetton balances for a specified address.

### Schema
```json
{
  "name": "get_wallet_balance",
  "description": "Fetch TON and Jetton balances for a given address",
  "inputSchema": {
    "type": "object",
    "properties": {
      "address": {
        "type": "string",
        "description": "The TON wallet address (Raw or User-friendly format)"
      }
    },
    "required": ["address"]
  }
}
```

---

## 2. Tool: `simulate_swap`

Simulates a swap on STON.fi or DeDust to find the best route and estimate slippage/outputs.

### Schema
```json
{
  "name": "simulate_swap",
  "description": "Simulate a swap routing between two tokens",
  "inputSchema": {
    "type": "object",
    "properties": {
      "offer_token": {
        "type": "string",
        "description": "Contract address of the token being offered"
      },
      "ask_token": {
        "type": "string",
        "description": "Contract address of the token being asked"
      },
      "amount": {
        "type": "string",
        "description": "Amount to swap in nano-units"
      },
      "dex": {
        "type": "string",
        "enum": ["stonfi", "dedust", "auto"],
        "description": "DEX platform to route through"
      }
    },
    "required": ["offer_token", "ask_token", "amount"]
  }
}
```

---

## 3. Tool: `execute_swap`

Signs and dispatches a swap transaction using the delegated agent key through the budgeting contract.

### Schema
```json
{
  "name": "execute_swap",
  "description": "Execute a swap transaction via the budgeting wallet",
  "inputSchema": {
    "type": "object",
    "properties": {
      "wallet_address": {
        "type": "string",
        "description": "Address of the deployed budgeting contract"
      },
      "target_address": {
        "type": "string",
        "description": "Address of the DEX router contract"
      },
      "amount": {
        "type": "string",
        "description": "Amount of offer token in nano-units"
      },
      "forward_payload_hex": {
        "type": "string",
        "description": "Hex-serialized cell containing the swap parameters"
      }
    },
    "required": ["wallet_address", "target_address", "amount", "forward_payload_hex"]
  }
}
```
