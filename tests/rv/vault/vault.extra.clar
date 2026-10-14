;; ---------------------------------------------------------------------------
;; RV ONLY: appended by tests/rv/build.py after tests/vault/rv.invariants.clar
;; (which keeps its eight invariants, context map and rv-* drivers) to the
;; generated vault copy where POOL is the deployer account.
;;
;; Checked wrappers: each runs ONE production entry point through try! (an
;; error rolls the whole call back, exactly like a failing transaction), then
;; compares balances before/after. A broken property does not revert: it
;; records itself in rv-violation and the call returns ok, so the
;; invariant-no-violation check below falsifies the run.
;; ---------------------------------------------------------------------------
(define-data-var rv-violation (optional { code: uint, a: uint, b: uint }) none)
(define-data-var rv-sales uint u0)
(define-data-var rv-finishes uint u0)
(define-data-var rv-recovers uint u0)

(define-private (rv-flag (code uint) (a uint) (b uint))
  (begin (if (is-none (var-get rv-violation)) (var-set rv-violation (some { code: code, a: a, b: b })) true) true))

(define-private (rv-ft (who principal)) (unwrap-panic (contract-call? .mock-ft get-balance who)))
;; every place vault funds may legitimately go: the pool, the market (and the
;; market treasury, which is the deployer = POOL here), the router, and the
;; Lazer oracle that collects the verify fee
(define-private (rv-snap)
  {
    v-ft: (sbtc-balance), v-stx: (stx-get-balance current-contract),
    ft-sum: (+ (sbtc-balance) (rv-ft POOL) (rv-ft .v6-market) (rv-ft .mock-router) (rv-ft .mock-lazer-oracle)),
    stx-sum: (+ (stx-get-balance current-contract) (stx-get-balance POOL) (stx-get-balance .v6-market)
               (stx-get-balance .mock-router) (stx-get-balance .mock-lazer-oracle)),
    caller-ft: (rv-ft tx-sender), caller-stx: (stx-get-balance tx-sender),
    pool-ft: (rv-ft POOL), pool-stx: (stx-get-balance POOL),
  })

;; funds only move between the vault and the allowed set; a caller that is
;; not POOL gains nothing
(define-private (rv-check-flows (b { v-ft: uint, v-stx: uint, ft-sum: uint, stx-sum: uint, caller-ft: uint, caller-stx: uint, pool-ft: uint, pool-stx: uint }))
  (let ((a (rv-snap)))
    (if (not (is-eq (get ft-sum a) (get ft-sum b))) (rv-flag u1 (get ft-sum b) (get ft-sum a)) true)
    (if (not (is-eq (get stx-sum a) (get stx-sum b))) (rv-flag u2 (get stx-sum b) (get stx-sum a)) true)
    (if (and (not (is-eq tx-sender POOL)) (> (get caller-ft a) (get caller-ft b))) (rv-flag u3 (get caller-ft b) (get caller-ft a)) true)
    (if (and (not (is-eq tx-sender POOL)) (> (get caller-stx a) (get caller-stx b))) (rv-flag u4 (get caller-stx b) (get caller-stx a)) true)
    a))

;; a sale: sold = sBTC that left the vault, out = STX that came in. The vault
;; floor for this entry is `limit`; every router leg may land
;; ROUTER_SLACK_SATS under, and a Jing market swap first takes its taker
;; rebate (at most JING_TAKER_REBATE_MAX_BPS of the amount) into the pot, so
;; jing-take's limit applies to the amount net of that rebate
(define-private (rv-check-sale (b { v-ft: uint, v-stx: uint, ft-sum: uint, stx-sum: uint, caller-ft: uint, caller-stx: uint, pool-ft: uint, pool-stx: uint }) (limit uint) (slack uint) (rebate-bps uint))
  (let ((a (rv-check-flows b))
        (sold (if (> (get v-ft b) (get v-ft a)) (- (get v-ft b) (get v-ft a)) u0))
        (out (if (> (get v-stx a) (get v-stx b)) (- (get v-stx a) (get v-stx b)) u0))
        (cut (+ slack (/ (+ (* sold rebate-bps) (- BPS_PRECISION u1)) BPS_PRECISION)))
        (base (if (> sold cut) (- sold cut) u0)))
    (var-set rv-sales (+ (var-get rv-sales) (if (> sold u0) u1 u0)))
    (if (< out (floor-out base limit)) (rv-flag u10 sold out) true)
    (if (> (get v-ft a) (get v-ft b)) (rv-flag u11 (get v-ft b) (get v-ft a)) true)
    ;; shown in the RV log line of the call
    { sold: sold, out: out, limit: limit, violation: (var-get rv-violation) }))

;; Optional pre-state for a checked call, chosen by `prep`: unless prep mod 4
;; is 0 it calms the oracles (DIA agrees with Lazer, fresh, RFQ native at the
;; mid); unless prep mod 3 is 0 (and only for POOL, like rv-release-window)
;; it ends the patience window; unless prep mod 5 is 0 it lifts the router
;; haircut. The rest of the time the faults rv-world / rv-haircut left stay. All of this is world/test state set BEFORE the
;; snapshot; the production call itself runs untouched.
(define-private (rv-prep (prep uint))
  (begin
    (if (> (mod prep u4) u0)
      (begin
        (unwrap-panic (contract-call? .mock-dia set-skew u10000))
        (unwrap-panic (contract-call? .mock-dia set-stale false))
        (unwrap-panic (contract-call? .mock-dia set-failed false))
        (unwrap-panic (contract-call? .mock-native set-failed false))
        (unwrap-panic (contract-call? .mock-native set-mid u32000000000000))
        true)
      true)
    (if (and (> (mod prep u3) u0) (is-eq contract-caller POOL)) (var-set window-blocks u0) true)
    (if (> (mod prep u5) u0) (unwrap-panic (contract-call? .mock-router set-haircut-bps u0)) true)
    true))

;; POOL opens a batch (mint + fund), as the pool's claim does
(define-public (rv-open (raw uint))
  (let ((amount (+ u1 (mod raw u3000000))))
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (try! (contract-call? .mock-ft mint amount POOL))
    (fund amount)))
(define-public (rv-open-b (raw uint)) (rv-open raw))

;; caller-funded router liquidity so sales can clear (mock mid 3,200 uSTX/sat)
(define-private (rv-liquidity (amount uint))
  (stx-transfer? (+ u1000 (* amount u3300)) tx-sender .mock-router))

(define-public (rv-haircut (raw uint))
  (contract-call? .mock-router set-haircut-bps (if (is-eq (mod raw u3) u0) u0 (mod raw u2500))))
;; STX maker on the market so jing-take has a book to hit. Only POOL (the
;; deployer here) makes: its fills land on POOL, already in every sum, so the
;; conservation checks stay tight (a wallet maker would be a new holder).
(define-public (rv-maker (raw uint))
  (begin (asserts! (is-eq tx-sender POOL) ERR_UNAUTHORIZED)
  (contract-call? .v6-market deposit-token-y (+ u10000000 (mod raw u5000000000)) u32000000000000 (some u0) 0x .mock-ft "mock-ft")))

(define-public (rv-checked-router-swap (prep uint))
  (let ((p (rv-prep prep)) (limit (floor-of (contract-call? .mock-lazer-oracle get-mid))))
    (try! (rv-liquidity (sbtc-balance)))
    (let ((b (rv-snap)))
      (try! (router-swap 0x))
      (ok (rv-check-sale b limit ROUTER_SLACK_SATS u0)))))

(define-public (rv-checked-split (raw uint) (prep uint))
  (let ((p (rv-prep prep)) (amount (+ u1 (mod raw (var-get max-chunk-sats))))
        (limit (floor-of (contract-call? .mock-lazer-oracle get-mid))))
    (try! (rv-liquidity amount))
    (let ((b (rv-snap)))
      (try! (router-swap-split amount u0 amount u0 u0 0x))
      (ok (rv-check-sale b limit ROUTER_SLACK_SATS u0)))))

(define-public (rv-checked-split-dia (raw uint) (prep uint))
  (let ((p (rv-prep prep)) (amount (+ u1 (mod raw (var-get max-chunk-sats))))
        (limit (get limit (try! (get-no-pyth-price)))))
    (try! (rv-liquidity amount))
    (let ((b (rv-snap)))
      (try! (router-swap-split-dia amount amount u0 u0))
      (ok (rv-check-sale b limit u0 u0)))))

(define-public (rv-checked-jing-take (raw uint) (prep uint))
  (let ((p (rv-prep prep)) (limit (floor-of (contract-call? .mock-lazer-oracle get-mid))) (b (rv-snap)))
    (try! (jing-take (+ u1 raw) 0x))
    (ok (rv-check-sale b limit u0 JING_TAKER_REBATE_MAX_BPS))))

;; second names for the checked sales: RV picks uniformly among public
;; functions, this weights the paths under test
(define-public (rv-checked-router-swap-b (prep uint)) (rv-checked-router-swap prep))
(define-public (rv-checked-split-b (raw uint) (prep uint)) (rv-checked-split raw prep))
(define-public (rv-checked-split-dia-b (raw uint) (prep uint)) (rv-checked-split-dia raw prep))
(define-public (rv-checked-jing-take-b (raw uint) (prep uint)) (rv-checked-jing-take raw prep))

;; finish sends balance - min(balance, budget) to POOL and keeps the rest
(define-public (rv-checked-finish)
  (let ((b (rv-snap))
        (bal (stx-get-balance current-contract))
        (budget (var-get pyth-fee-budget))
        (want (- bal (if (< bal budget) bal budget))))
    (let ((amount (try! (finish))) (a (rv-check-flows b)))
      (var-set rv-finishes (+ (var-get rv-finishes) u1))
      (if (not (is-eq amount want)) (rv-flag u20 want amount) true)
      (if (not (is-eq (- (get v-stx b) (get v-stx a)) want)) (rv-flag u21 want (- (get v-stx b) (get v-stx a))) true)
      (if (not (is-eq (- (get pool-stx a) (get pool-stx b)) want)) (rv-flag u22 want (- (get pool-stx a) (get pool-stx b))) true)
      (if (var-get ready-to-finish) (rv-flag u23 u0 u0) true)
      (ok { amount: amount, violation: (var-get rv-violation) }))))

;; recovery: everything (wallet + market positions) goes to POOL, vault empty
(define-public (rv-checked-recover)
  (let ((b (rv-snap)))
    (let ((r (try! (emergency-recover))) (a (rv-check-flows b)))
      (var-set rv-recovers (+ (var-get rv-recovers) u1))
      (if (not (is-eq (- (get pool-stx a) (get pool-stx b)) (get stx r))) (rv-flag u30 (get stx r) (- (get pool-stx a) (get pool-stx b))) true)
      (if (not (is-eq (- (get pool-ft a) (get pool-ft b)) (get sbtc r))) (rv-flag u31 (get sbtc r) (- (get pool-ft a) (get pool-ft b))) true)
      (if (> (stx-get-balance current-contract) u0) (rv-flag u32 (stx-get-balance current-contract) u0) true)
      (if (not (is-empty)) (rv-flag u33 (sbtc-balance) u0) true)
      (ok { recovered: r, violation: (var-get rv-violation) }))))

;; permissionless entries run by a non-POOL account must not pay the caller
(define-public (rv-checked-close-batch)
  (let ((b (rv-snap)))
    (try! (close-batch))
    (rv-check-flows b)
    (ok (var-get rv-violation))))
(define-public (rv-checked-jing-reclaim (prep uint))
  (let ((p (rv-prep prep)) (b (rv-snap)))
    (try! (jing-reclaim))
    (rv-check-flows b)
    (ok (var-get rv-violation))))

(define-read-only (invariant-no-violation)
  (is-none (var-get rv-violation)))
(define-read-only (invariant-batch-xor-ready)
  (not (and (is-some (var-get batch-start)) (var-get ready-to-finish))))
;; ready-to-finish only once the batch emptied
(define-read-only (invariant-ready-means-empty-market)
  (or (not (var-get ready-to-finish))
      (and (is-eq (contract-call? .v6-market get-token-x-deposit (contract-call? .v6-market get-current-cycle) current-contract) u0)
           (is-eq (contract-call? .v6-market get-token-x-parked current-contract) u0))))
(define-read-only (invariant-budget-bounded)
  (<= (var-get pyth-fee-budget) MAX_PYTH_FEE_BUDGET))
