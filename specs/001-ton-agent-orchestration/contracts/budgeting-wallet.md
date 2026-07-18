# Smart Contract Specification: Budgeting Wallet (Tolk)

This document describes the design and interface of the on-chain `budgeting-wallet` contract compiled from Tolk.

---

## 1. Storage Layout

The persistent storage of the contract is serialized into a single Cell with the following format:

```text
cell
├── owner_address: MsgAddress
├── agent_public_key: uint256
├── daily_spent_limit: Coins (VarUInteger 16)
├── daily_spent_accumulated: Coins (VarUInteger 16)
└── last_reset_timestamp: uint32
```

---

## 2. Inbound Message Layout

The payload (in_msg_body) sent to the contract by the agent must conform to this schema:

```text
cell (in_msg_body)
├── signature: bits512 (64 bytes)
└── message_content (cell payload used for slice_hash)
    ├── transfer_amount: Coins (VarUInteger 16)
    ├── target_address: MsgAddress
    └── forward_payload: Ref (DEX swap routing parameters Cell)
```

---

## 3. Exit/Error Codes

The contract throws exceptions using standard TON exit codes when validation fails:

| Exit Code | Reason | Description |
|---|---|---|
| `101` | Invalid Signature | The signature of the message does not match the authorized `agent_public_key` |
| `102` | Limit Exceeded | The current swap would cause the daily spend to exceed the `daily_spent_limit` |
