;; ---------------------------------------------------------------------------
;; RV ONLY (tests/rv/build.py appends this to the generated mock-pox copy).
;; A small pox-5 staking model so the pool is fuzzed against the same rules
;; contracts/external/pox-5.clar enforces:
;;   stake        no active lock; validate-stake! on the TARGET signer manager
;;                with the full amount; shares for first..first+num-1
;;   stake-update active lock; amount only grows; may move to another signer
;;                (validate-stake! on the new manager with the new total);
;;                future cycles (> current) are moved, past ones never change
;;   unstake      active lock; amount kept, unlock = current + 1, future
;;                shares dropped
;; get-staker-info (prepended by tests/vault/build.py) answers none once
;; first + num <= current cycle, like pox-5. Shares of a cycle <= current never
;; change, so a reward cycle is only claimable once it is in the past
;; (claim-rewards is patched in tests/rv/build.py: past cycle, signer had
;; stake, at most 120 batches recorded in rv-claims).
;; ---------------------------------------------------------------------------
(define-constant RV_OTHER_SIGNER 'ST000000000000000000002AMW42H)
(define-constant RV_OFFSETS (list u0 u1 u2 u3 u4 u5))
(define-constant RV_MAX_CYCLE u400)
;; every reward batch the pool claimed, in claim order (the pool's tranche
;; index is the number of earlier claims for that cycle). A pool tx that fails
;; after claiming rolls this back with everything else.
(define-data-var rv-claims (list 120 { c: uint, t: uint }) (list))
(define-map rv-claim-count uint uint)
(define-read-only (rv-get-claims) (var-get rv-claims))
(define-private (rv-record-claim (c uint))
  (let ((t (default-to u0 (map-get? rv-claim-count c))))
    (match (as-max-len? (append (var-get rv-claims) { c: c, t: t }) u120)
      l (begin (var-set rv-claims l) (map-set rv-claim-count c (+ t u1)) true)
      false)))
(define-map rv-lock principal uint)

(define-read-only (rv-get-lock (staker principal))
  (default-to u0 (map-get? rv-lock staker)))
(define-read-only (rv-get-cycle) (var-get cycle))

(define-private (rv-add-share (offset uint) (acc { staker: principal, signer: principal, from: uint, to: uint, amount: uint }))
  (let ((c (+ (get from acc) offset))
        (k { staker: (get staker acc), cycle: c, signer: (get signer acc) })
        (t { cycle: c, signer: (get signer acc) }))
    (if (< c (get to acc))
      (begin
        (map-set totals t (+ (get amount acc) (- (default-to u0 (map-get? totals t)) (default-to u0 (map-get? shares k)))))
        (map-set shares k (get amount acc))
        acc)
      acc)))

(define-private (rv-drop-share (offset uint) (acc { staker: principal, signer: principal, from: uint, to: uint, amount: uint }))
  (let ((c (+ (get from acc) offset))
        (k { staker: (get staker acc), cycle: c, signer: (get signer acc) })
        (t { cycle: c, signer: (get signer acc) }))
    (if (< c (get to acc))
      (begin
        (map-set totals t (- (default-to u0 (map-get? totals t)) (default-to u0 (map-get? shares k))))
        (map-delete shares k)
        acc)
      acc)))

;; `pm` must be the calling pool itself (the pool's rv-* wrapper passes the
;; trait RV generated): a foreign trait value is refused, not dispatched.
(define-public (rv-stake (pm <signer-trait>) (staker principal) (amount uint) (num uint) (to-pool bool))
  (let ((c (+ (var-get cycle) u1))
        (signer (if to-pool (contract-of pm) RV_OTHER_SIGNER)))
    (asserts! (is-eq (contract-of pm) contract-caller) (err u7001))
    (asserts! (is-none (get-staker-info staker)) (err u7002))
    (asserts! (and (>= num u1) (<= num u3)) (err u7003))
    (if to-pool (try! (contract-call? pm validate-stake! staker c num amount u0 false none)) true)
    (fold rv-add-share RV_OFFSETS { staker: staker, signer: signer, from: c, to: (+ c num), amount: amount })
    (map-set staker-info staker { signer: signer, first-reward-cycle: c, num-cycles: num })
    (map-set rv-lock staker amount)
    (ok true)))

(define-public (rv-stake-update (pm <signer-trait>) (staker principal) (extend uint) (increase uint) (to-pool bool))
  (let ((info (unwrap! (get-staker-info staker) (err u7004)))
        (cur (var-get cycle))
        (old-unlock (+ (get first-reward-cycle info) (get num-cycles info)))
        (unlock (+ old-unlock extend))
        (amount (+ (rv-get-lock staker) increase))
        (num (- unlock cur u1))
        (signer (if to-pool (contract-of pm) RV_OTHER_SIGNER)))
    (asserts! (is-eq (contract-of pm) contract-caller) (err u7001))
    (asserts! (and (>= num u1) (<= num u5)) (err u7003))
    (if to-pool (try! (contract-call? pm validate-stake! staker (+ cur u1) num amount u0 false none)) true)
    (fold rv-drop-share RV_OFFSETS { staker: staker, signer: (get signer info), from: (+ cur u1), to: old-unlock, amount: u0 })
    (fold rv-add-share RV_OFFSETS { staker: staker, signer: signer, from: (+ cur u1), to: unlock, amount: amount })
    (map-set staker-info staker { signer: signer, first-reward-cycle: (get first-reward-cycle info), num-cycles: (+ (get num-cycles info) extend) })
    (map-set rv-lock staker amount)
    (ok true)))

(define-public (rv-unstake (staker principal))
  (let ((info (unwrap! (get-staker-info staker) (err u7004)))
        (cur (var-get cycle))
        (old-unlock (+ (get first-reward-cycle info) (get num-cycles info))))
    (fold rv-drop-share RV_OFFSETS { staker: staker, signer: (get signer info), from: (+ cur u1), to: old-unlock, amount: u0 })
    (map-set staker-info staker (merge info { num-cycles: (- (+ cur u1) (get first-reward-cycle info)) }))
    (ok true)))

(define-public (rv-next-cycle)
  (begin (asserts! (< (var-get cycle) RV_MAX_CYCLE) (err u7005))
    (ok (var-set cycle (+ (var-get cycle) u1)))))

(define-public (rv-next-dist)
  (begin (asserts! true (err u7006)) (ok (var-set dist (+ (var-get dist) u1)))))

(define-public (rv-set-reward (r uint)) (begin (asserts! true (err u0)) (ok (var-set reward r))))
