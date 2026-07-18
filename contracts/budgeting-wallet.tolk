// Guardrail Wallet Contract written in Tolk (TON 2026 standard)
// Restricts trading limits for delegated Agent keys
//
// Storage layout (serialized in a single cell):
//   cell
//   ├── owner_address: MsgAddress
//   ├── agent_public_key: uint256
//   ├── daily_spent_limit: Coins (VarUInteger 16)
//   ├── daily_spent_accumulated: Coins (VarUInteger 16)
//   └── last_reset_timestamp: uint32
//
// Inbound message body layout:
//   cell (in_msg_body)
//   ├── signature: bits512 (64 bytes)
//   └── message_content (used for slice_hash)
//       ├── transfer_amount: Coins
//       ├── target_address: MsgAddress
//       └── forward_payload: Ref (DEX swap routing parameters Cell)
//
// Exit codes:
//   101 — Invalid Signature
//   102 — Daily Limit Exceeded

// ─────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────

struct Storage {
    owner_address: slice;
    agent_public_key: int;
    daily_spent_limit: int;
    daily_spent_accumulated: int;
    last_reset_timestamp: int;
}

// ─────────────────────────────────────────────────────────────────────
// Inbound message body (signed swap instruction)
// ─────────────────────────────────────────────────────────────────────

struct SignedSwapBody {
    signature: slice;       // 512 bits (64 bytes)
    transfer_amount: int;   // coins
    target_address: slice;  // MsgAddress
    forward_payload: cell;  // ref
}

// ─────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────

fun loadStorage(): Storage {
    var ds = get_data().begin_parse();
    return Storage(ds.read_msg_addr(), ds.read_uint(256), ds.read_coins(), ds.read_coins(), ds.read_uint(32));
}

fun saveStorage(s: Storage) {
    set_data(begin_cell()
        .store_slice(s.owner_address)
        .store_uint(s.agent_public_key, 256)
        .store_coins(s.daily_spent_limit)
        .store_coins(s.daily_spent_accumulated)
        .store_uint(s.last_reset_timestamp, 32)
        .end_cell());
}

// ─────────────────────────────────────────────────────────────────────
// Message body parser
// ─────────────────────────────────────────────────────────────────────

fun parseSignedSwapBody(body: slice): SignedSwapBody {
    var sig = body.read_slice(512);
    var amount = body.read_coins();
    var target = body.read_msg_addr();
    var payload = body.read_ref();
    return SignedSwapBody(sig, amount, target, payload);
}

// ─────────────────────────────────────────────────────────────────────
// Entrypoint: internal non-bounced messages
// ─────────────────────────────────────────────────────────────────────

// The InMessage type provides parsed message metadata:
//   in.body        — slice of the message body (the part after op/query_id)
//   in.bounced     — bool, true if this is a bounced message
//   in.sender      — MsgAddress of the sender
//   in.value       — coins attached to the message
//   in.rawBody     — the full body cell
//   in.rawFullBody — the full incoming message cell
fun onInternalMessage(in: InMessage) {
    // Ignore empty top-up messages
    if in.body.slice_empty?() { return; }
    // Ignore bounced messages
    if in.bounced { return; }

    // Load current storage
    var s = loadStorage();

    // The message body layout:
    //   [ signature: bits512 ]
    //   [ transfer_amount: coins ]
    //   [ target_address: MsgAddress ]
    //   [ forward_payload: ^Cell ]
    //
    // The signature covers the hash of everything AFTER the signature field.
    var signature = in.body.read_slice(512);
    var message_hash = slice_hash(in.body);
    assert(check_signature(message_hash, signature, s.agent_public_key), 101);

    // Check and reset daily limit if 24h window has elapsed
    var current_time = now();
    if current_time - s.last_reset_timestamp > 86400 {
        s.daily_spent_accumulated = 0;
        s.last_reset_timestamp = current_time;
    }

    // Validate transfer amount against daily limit
    var transfer_amount = in.body.read_coins();
    assert(s.daily_spent_accumulated + transfer_amount <= s.daily_spent_limit, 102);

    // Update accumulated spend
    s.daily_spent_accumulated += transfer_amount;
    saveStorage(s);

    // Forward the swap instruction to the target DEX contract
    var target_address = in.body.read_msg_addr();
    var forward_payload = in.body.read_ref();

    // Build the outbound message — nobounce, carry all remaining value
    var msg = begin_cell()
        .store_uint(0x18, 6)                     // nobounce
        .store_slice(target_address)
        .store_coins(transfer_amount)
        .store_uint(1, 1 + 4 + 4 + 64 + 32 + 1 + 1) // refs=1
        .store_ref(forward_payload)
        .end_cell();

    send_raw_message(msg, 64); // carry all remaining value
}

// ─────────────────────────────────────────────────────────────────────
// Getters
// ─────────────────────────────────────────────────────────────────────

// Returns the full storage state for off-chain inspection
get fun get_wallet_data(): (slice, int, int, int, int) {
    var s = loadStorage();
    return (s.owner_address, s.agent_public_key, s.daily_spent_limit, s.daily_spent_accumulated, s.last_reset_timestamp);
}

// Returns the current accumulated spend (useful for monitoring)
get fun get_accumulated_spend(): int {
    var s = loadStorage();
    // Auto-reset if past the 24h window
    var current_time = now();
    if current_time - s.last_reset_timestamp > 86400 {
        return 0;
    }
    return s.daily_spent_accumulated;
}

// Returns whether the contract is within its daily limit
get fun is_within_limit(amount: int): bool {
    var s = loadStorage();
    var current_time = now();
    var accumulated = current_time - s.last_reset_timestamp > 86400 ? 0 : s.daily_spent_accumulated;
    return accumulated + amount <= s.daily_spent_limit;
}
