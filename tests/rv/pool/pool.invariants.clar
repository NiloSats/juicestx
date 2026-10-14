;; ---------------------------------------------------------------------------
;; RV ONLY: appended by tests/rv/build.py to a generated copy of
;; contracts/pox-5/juice-pool-sbtc-signer.clar (principals rebound to the
;; tests/vault fixtures, nothing else changed). Production never sees this.
;;
;; Stakers are six fixed accounts (RV_ACTORS); every stake reaches the pool
;; through the mock-pox model (validate-stake! with contract-caller = pox),
;; so sums over the actors ARE sums over the og-stakers map. Every reward
;; batch the pool ever claimed is listed by the mock (rv-get-claims, whatever
;; entry point claimed it), so the scans below cover every batch.
;; ---------------------------------------------------------------------------
(define-map context (string-ascii 100) { called: uint })
(define-public (update-context (function-name (string-ascii 100)) (called uint))
  (ok (map-set context function-name { called: called })))

(define-constant RV_ACTORS (list
  'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
  'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG
  'ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC
  'ST2NEB84ASENDXKYGJPQW86YXQCEFEX2ZQPG87ND
  'ST2REHHS5J3CERCRBEPMGH7921Q6PYKAADT7JP2VB
  'ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0))
(define-constant RV_VAULT .juice-sbtc-autoswap)
(define-constant ERR_RV (err u9900))

(define-private (rv-actor (i uint))
  (unwrap-panic (element-at? RV_ACTORS (mod i u6))))
;; 0 (pox-5 has no minimum, see README), or up to 1.5M STX in 30-STX steps:
;; a handful of stakes covers the 2.1M cap
(define-private (rv-amount (raw uint))
  (if (is-eq (mod raw u29) u0) u0
    (+ u1 (mod (* (mod raw u100000) u30000000) u1500000000000))))
;; a reward cycle that is already in the past (claimable), or none
(define-private (rv-past-cycle (back uint))
  (let ((cur (contract-call? .mock-pox rv-get-cycle)) (b (if (is-eq (mod back u4) u3) u2 u1)))
    (if (and (> cur b) (>= (- cur b) u151)) (some (- cur b)) none)))
;; one of the claimed batches (or cycle 0 when none yet)
(define-private (rv-batch-of (c uint) (t uint))
  (let ((l (contract-call? .mock-pox rv-get-claims)))
    (match (element-at? l (mod (+ c t) (+ u1 (len l))))
      b { cycle: (get c b), tranche: (get t b) }
      { cycle: u0, tranche: u0 })))

;; ---- pox-5 side ----------------------------------------------------------
(define-public (rv-stake (pm <signer-mgr>) (who uint) (raw uint) (num uint) (to-pool bool))
  (contract-call? .mock-pox rv-stake pm (rv-actor who) (rv-amount raw) (+ u1 (mod num u3)) to-pool))
(define-public (rv-stake-update (pm <signer-mgr>) (who uint) (extend uint) (raw uint) (to-pool bool))
  (contract-call? .mock-pox rv-stake-update pm (rv-actor who) (mod extend u3)
    (if (is-eq (mod raw u3) u0) u0 (rv-amount raw)) to-pool))
(define-public (rv-unstake (who uint))
  (contract-call? .mock-pox rv-unstake (rv-actor who)))
(define-public (rv-next-cycle) (contract-call? .mock-pox rv-next-cycle))
(define-public (rv-next-dist) (contract-call? .mock-pox rv-next-dist))

;; ---- OG / fee admin --------------------------------------------------------
(define-public (rv-evict (who uint)) (evict-og (rv-actor who)))
(define-public (rv-raise-cap (raw uint))
  (raise-og-cap (+ (var-get og-cap-ustx) u1 (mod raw u500000000000))))
(define-public (rv-propose-fee (raw uint)) (propose-fee-bips (mod raw u501)))

;; ---- rewards ---------------------------------------------------------------
(define-public (rv-claim (back uint) (raw uint))
  (let ((c (unwrap! (rv-past-cycle back) ERR_RV)))
    (try! (contract-call? .mock-pox rv-set-reward (+ u1 (mod raw u1000000))))
    (try! (pox-claim-rewards (list) c RV_VAULT))
    (ok c)))
;; anyone can run the vault's permissionless router-swap; the caller funds
;; the mock router's STX side first (it buys at the mock mid)
(define-public (rv-sell)
  (let ((bal (unwrap-panic (contract-call? .mock-ft get-balance RV_VAULT))))
    (try! (stx-transfer? (+ u1000 (* bal u3200)) tx-sender .mock-router))
    (contract-call? .juice-sbtc-autoswap router-swap 0x)))
(define-public (rv-finalize) (finalize-swap RV_VAULT))
(define-public (rv-recover) (emergency-recover RV_VAULT))
(define-public (rv-vault-window (raw uint))
  (set-vault-window-blocks (if (< (mod raw u4) u3) u0 (mod raw u289)) RV_VAULT))
;; permissionless round trip: claim, sell, finalize (needs the vault window
;; elapsed: rv-vault-window sets it, mostly to 0)
(define-public (rv-batch (back uint) (raw uint))
  (begin
    (try! (rv-claim back raw))
    (try! (rv-sell))
    (finalize-swap RV_VAULT)))
(define-public (rv-pay (c uint) (t uint) (picks (list 12 uint)))
  (let ((b (rv-batch-of c t)))
    (pay-stx-stakers (map rv-actor picks) (get cycle b) (get tranche b))))
(define-public (rv-pay-sbtc (c uint) (t uint) (picks (list 12 uint)))
  (let ((b (rv-batch-of c t)))
    (pay-recovered-sbtc-stakers (map rv-actor picks) (get cycle b) (get tranche b))))
(define-public (rv-sweep (c uint) (t uint))
  (let ((b (rv-batch-of c t))) (sweep-tranche-dust (get cycle b) (get tranche b))))
(define-public (rv-sweep-sbtc (c uint) (t uint))
  (let ((b (rv-batch-of c t))) (sweep-recovered-sbtc-dust (get cycle b) (get tranche b))))
(define-public (rv-withdraw-fees (raw uint))
  (withdraw-fees (mod raw (+ u1 (var-get earned-fees))) tx-sender))
(define-public (rv-withdraw-sbtc-fees (raw uint))
  (withdraw-sbtc-fees (mod raw (+ u1 (var-get earned-sbtc-fees))) tx-sender))

;; ---- macro step: several stakes, a cycle, a batch, a payout ----------------
;; Each stake goes through contract-call? into the mock (a failing one rolls
;; back on its own and is skipped). The batch runs only when its read-only
;; preconditions hold and then all-or-nothing (try!), so a failure reverts the
;; whole call like a failed transaction; pay-stx-stakers fails only before
;; writing anything.
(define-private (rv-op (pm <signer-mgr>) (op (optional { who: uint, raw: uint, num: uint, to-pool: bool, update: bool })))
  (match op o
    (is-ok (if (get update o)
      (contract-call? .mock-pox rv-stake-update pm (rv-actor (get who o)) (mod (get num o) u3)
        (if (is-eq (mod (get raw o) u3) u0) u0 (rv-amount (get raw o)))
        (or (get to-pool o) (> (mod (get num o) u4) u0)))
      ;; three in four to this pool
      (contract-call? .mock-pox rv-stake pm (rv-actor (get who o)) (rv-amount (get raw o))
        (+ u1 (mod (get num o) u3)) (or (get to-pool o) (> (mod (get raw o) u4) u0)))))
    false))
;; why no batch: bit flags (1 swap pending, 2 no shares, 4 claim list full,
;; 8 same distribution, 16 vault window set, 32 router cooldown, 64 no past cycle)
(define-read-only (rv-batch-why (c uint))
  (let ((cfg (contract-call? .juice-sbtc-autoswap get-config))
        (last (get-last-claim-dist-cycle c)))
    (+ (if (is-none (var-get pending-swap)) u0 u1)
       (if (> (get-cycle-total-shares c) u0) u0 u2)
       (if (< (len (contract-call? .mock-pox rv-get-claims)) u120) u0 u4)
       (if (match last l (> (contract-call? .mock-pox current-distribution-cycle) l) true) u0 u8)
       (if (is-eq (get window-blocks cfg) u0) u0 u16)
       (if (>= burn-block-height (+ (get last-router-swap cfg) (get router-cooldown-blocks cfg))) u0 u32))))
(define-private (rv-batch-ready (c uint)) (is-eq (rv-batch-why c) u0))
(define-private (rv-epoch-impl (pm <signer-mgr>) (ops (list 4 { who: uint, raw: uint, num: uint, to-pool: bool, update: bool }))
    (back uint) (raw uint) (picks (list 12 uint)))
  (let ((resumed (and (var-get paused) (is-ok (set-paused false))))
        (staked (+ (if (rv-op pm (element-at? ops u0)) u1 u0) (if (rv-op pm (element-at? ops u1)) u1 u0)
                   (if (rv-op pm (element-at? ops u2)) u1 u0) (if (rv-op pm (element-at? ops u3)) u1 u0)))
        ;; the cycle moves one epoch in two, so locks span several batches
        (moved (and (is-eq (mod raw u2) u0) (is-ok (contract-call? .mock-pox rv-next-cycle))))
        ;; the admin opens the vault window once (set-vault-window-blocks
        ;; refuses mid-batch and for non-admins without writing anything)
        (window (and (is-none (var-get pending-swap))
                     (is-ok (set-vault-window-blocks u0 RV_VAULT))))
        ;; and pays any claimed batch (fails only before writing)
        (old (rv-batch-of raw back))
        (paid-old (match (pay-stx-stakers (map rv-actor picks) (get cycle old) (get tranche old)) n n e u0)))
    (match (rv-past-cycle back)
      c (if (rv-batch-ready c)
          (let ((chunk (get max-chunk-sats (contract-call? .juice-sbtc-autoswap get-config)))
                (tranche (get-tranche-count c)))
            (try! (contract-call? .mock-pox rv-set-reward (+ u1 (mod raw chunk))))
            (try! (pox-claim-rewards (list) c RV_VAULT))
            (try! (rv-sell))
            (try! (finalize-swap RV_VAULT))
            (ok { staked: staked, moved: moved, batch: true, paid-old: paid-old,
                  paid: (match (pay-stx-stakers (map rv-actor picks) c tranche) n n e u0), why: u0 }))
          (ok { staked: staked, moved: moved, batch: false, paid-old: paid-old, paid: u0, why: (rv-batch-why c) }))
      (ok { staked: staked, moved: moved, batch: false, paid-old: paid-old, paid: u0, why: u64 }))))
;; three names for the same step: RV picks uniformly among ~60 public
;; functions, this weights the end-to-end path
(define-public (rv-epoch (pm <signer-mgr>) (ops (list 4 { who: uint, raw: uint, num: uint, to-pool: bool, update: bool })) (back uint) (raw uint) (picks (list 12 uint)))
  (rv-epoch-impl pm ops back raw picks))
(define-public (rv-epoch-b (pm <signer-mgr>) (ops (list 4 { who: uint, raw: uint, num: uint, to-pool: bool, update: bool })) (back uint) (raw uint) (picks (list 12 uint)))
  (rv-epoch-impl pm ops back raw picks))
(define-public (rv-epoch-c (pm <signer-mgr>) (ops (list 4 { who: uint, raw: uint, num: uint, to-pool: bool, update: bool })) (back uint) (raw uint) (picks (list 12 uint)))
  (rv-epoch-impl pm ops back raw picks))

;; ---- scans -----------------------------------------------------------------
(define-private (rv-shares (who principal) (c uint))
  (contract-call? .mock-pox get-staker-shares-staked-for-cycle who c none current-contract))

;; per batch: fees charged = sum over paid stakers of gross - net, where
;; gross = pot * shares / total, exactly what pay-one computed (pot, shares and
;; total are frozen once the batch is finalized and its cycle is past)
(define-private (rv-fee-of (who principal) (acc { c: uint, t: uint, pot: uint, total: uint, stx: bool, sum: uint }))
  (match (if (get stx acc)
           (map-get? stx-paid { reward-cycle: (get c acc), tranche: (get t acc), staker: who })
           (map-get? recovered-sbtc-paid { reward-cycle: (get c acc), tranche: (get t acc), staker: who }))
    net (merge acc { sum: (+ (get sum acc)
           (- (/ (* (get pot acc) (rv-shares who (get c acc))) (get total acc)) net)) })
    acc))

(define-private (rv-scan-batch (bt { c: uint, t: uint }) (acc { ok: bool, residue: uint, fees: uint, sresidue: uint, sfees: uint, batches: uint }))
  (let ((c (get c bt)) (t (get t bt))
        (pot (get-stx-pot c t))
        (paid (get-tranche-paid c t))
        (spot (get-recovered-sbtc-pot c t))
        (spaid (default-to u0 (map-get? recovered-sbtc-tranche-paid { reward-cycle: c, tranche: t })))
        (total (get-cycle-total-shares c))
        (fin (default-to false (map-get? finalized-tranches { reward-cycle: c, tranche: t }))))
    {
      ok: (and (get ok acc)
        (< t (get-tranche-count c))
        (<= paid pot)
        (<= (get-tranche-paid-shares c t) total)
        (<= spaid spot)
        (<= (get-recovered-sbtc-paid-shares c t) total)
        ;; only a finalized batch carries a pot or a payout
        (or fin (and (is-eq pot u0) (is-eq paid u0) (is-eq spot u0)))),
      residue: (+ (get residue acc) (- pot paid)),
      sresidue: (+ (get sresidue acc) (- spot spaid)),
      fees: (if (> total u0)
        (get sum (fold rv-fee-of RV_ACTORS { c: c, t: t, pot: pot, total: total, stx: true, sum: (get fees acc) }))
        (get fees acc)),
      sfees: (if (> total u0)
        (get sum (fold rv-fee-of RV_ACTORS { c: c, t: t, pot: spot, total: total, stx: false, sum: (get sfees acc) }))
        (get sfees acc)),
      batches: (+ (get batches acc) (if fin u1 u0)),
    }))

(define-read-only (rv-scan)
  (fold rv-scan-batch (contract-call? .mock-pox rv-get-claims)
    { ok: true, residue: u0, fees: u0, sresidue: u0, sfees: u0, batches: u0 }))

(define-private (rv-sum-cover (who principal) (acc uint)) (+ acc (get-og-ustx who)))
(define-private (rv-cover-ok (who principal) (acc bool))
  (and acc (or (not (og-staying who))
               (<= (get-og-ustx who) (contract-call? .mock-pox rv-get-lock who)))))

;; ---- invariants --------------------------------------------------------------
(define-read-only (invariant-og-covered-is-sum)
  (is-eq (var-get og-covered-ustx) (fold rv-sum-cover RV_ACTORS u0)))
(define-read-only (invariant-og-covered-le-cap)
  (<= (var-get og-covered-ustx) (var-get og-cap-ustx)))
(define-read-only (invariant-og-seats-is-count)
  (is-eq (var-get og-seats) (len (filter is-og RV_ACTORS))))
(define-read-only (invariant-og-cover-le-lock)
  (fold rv-cover-ok RV_ACTORS true))
(define-read-only (invariant-og-cap-at-least-initial)
  (>= (var-get og-cap-ustx) u2100000000000))
(define-read-only (invariant-tranche-paid-bounded)
  (get ok (rv-scan)))
(define-read-only (invariant-earned-fees-le-charged)
  (let ((s (rv-scan)))
    (and (<= (var-get earned-fees) (get fees s))
         (<= (var-get earned-sbtc-fees) (get sfees s)))))
(define-read-only (invariant-stx-covers-pots-and-fees)
  (let ((s (rv-scan)))
    (>= (stx-get-balance current-contract) (+ (get residue s) (var-get earned-fees)))))
(define-read-only (invariant-sbtc-covers-pots-and-fees)
  (let ((s (rv-scan)))
    (>= (unwrap-panic (contract-call? .mock-ft get-balance current-contract))
        (+ (get sresidue s) (var-get earned-sbtc-fees)))))
;; stronger than the two above: no STX/sBTC enters the pool outside the
;; vault's finish / recover in this harness, so the books balance exactly
(define-read-only (invariant-stx-books-exact)
  (let ((s (rv-scan)))
    (is-eq (stx-get-balance current-contract) (+ (get residue s) (var-get earned-fees)))))
(define-read-only (invariant-sbtc-books-exact)
  (let ((s (rv-scan)))
    (is-eq (unwrap-panic (contract-call? .mock-ft get-balance current-contract))
           (+ (get sresidue s) (var-get earned-sbtc-fees)))))
(define-read-only (invariant-fee-bips-bounded)
  (and (<= (var-get fee-bips) MAX_FEE_BIPS)
       (match (var-get pending-fee) f (<= f MAX_FEE_BIPS) true)))
(define-read-only (invariant-pending-swap-is-open-tranche)
  (match (var-get pending-swap)
    b (and (not (default-to false (map-get? finalized-tranches b)))
           (is-eq (+ (get tranche b) u1) (get-tranche-count (get reward-cycle b))))
    true))
