# Phase 4 Architectural Rationale: Android Hardware Key Attestation vs. Google Play Integrity

## 1. Executive Summary

EdgePay-CF's companion Android application operates as an automated payment verification bridge for Mobile Financial Services (MFS) across South Asia (bKash, Nagad, Rocket, Upay). In Phase 3, message payloads were secured with canonical formatting, per-request nonces, strict 300-second timestamp freshness windows, and carrier shortcode verification.

For Phase 4, device integrity verification was initially planned using Google Play Integrity API. However, deep evaluation against the real-world operational profile of budget merchant companion hardware in Bangladesh and India revealed fatal structural mismatches.

EdgePay-CF replaced Google Play Integrity with **AOSP Hardware-Backed Key Attestation (Keymaster / Keymint)** verified against Google's pinned hardware root authorities. This document records the engineering decisions, failure analyses, and architectural trade-offs.

---

## 2. Why Google Play Integrity Failed for Target Deployments

Google Play Integrity provides cloud-based app and device verdict tokens evaluated by Google's servers. While suitable for standard consumer apps on retail Western flagships, it fails across four non-negotiable vectors in emerging market merchant environments:

### 2.1 Absence of Google Mobile Services (GMS) & Uncertified ROMs
In the target operating markets (Bangladesh, rural India), merchant companion phones are overwhelmingly low-cost devices manufactured by regional OEMs (Walton, Symphony, itel, Lava, Micromax, Tecno). Many of these devices run custom AOSP builds that:
- Lack licensed Google Mobile Services (GMS).
- Fail SafetyNet / Play Integrity device recognition due to uncertified bootloader signatures or modified vendor partitions.
- Experience intermittent Play Services background service crashes.

Under Play Integrity, these legitimate merchant appliances fail device verification, permanently locking merchants out of automated payment processing.

### 2.2 User Account Absence on Dedicated Appliances
Play Integrity API calls require an authenticated, active Google Account on the Android operating system. In production, companion phones are deployed as dedicated headless appliances inside merchant retail stores or server racks. Forcing merchants to provision and maintain personal Google accounts on commercial payment bridges introduces credential churn, account suspensions, 2FA lockouts, and compliance vulnerabilities.

### 2.3 Play Store Policy Restrictions on SMS Permissions
Google Play Store policy strictly bans applications from accessing the `RECEIVE_SMS` and `READ_SMS` permissions unless the app is designated as the device's default SMS handler. Because the companion app is a background payment automation bridge and not an end-user messaging app, **it cannot be distributed through the Google Play Store**.

The APK is distributed through direct sideloading or Enterprise MDM. Play Integrity heavily penalizes sideloaded APKs:
- `appLicensingVerdict`: `UNLICENSED`
- `appRecognitionVerdict`: `UNRECOGNIZED_VERSION`

Relying on Play Integrity would require maintaining brittle exception lists that negate the security guarantees of the API.

### 2.4 Cloud Subrequest Overhead & Availability Dependency
Play Integrity requires the Cloudflare Worker to make an external HTTPS call to Google's decryption API (`playintegrity.googleapis.com`) on pairing and authentication events. This introduces:
- Network latency (150ms–400ms roundtrip from edge PoPs).
- Third-party dependency: Google API downtime halts merchant onboarding.
- API quota limitations and billing overhead.

---

## 3. The Solution: AOSP Hardware-Backed Key Attestation

AOSP Keymaster (Android 7.0+) and Keymint (Android 12+) provide a pure hardware-level security primitive that operates directly within the device's **Trusted Execution Environment (TEE)** or dedicated **StrongBox** hardware security module (HSM).

### 3.1 Architectural Advantages
1. **Zero GMS Dependency**: Functions on pure AOSP without Google Play Services, Google framework services, or logged-in accounts.
2. **Distribution Agnostic**: Evaluates cryptographic properties of the hardware and verified boot state, regardless of whether the APK was sideloaded or MDM-managed.
3. **Hermetic Edge Verification**: The Cloudflare Worker verifies the complete X.509 certificate chain and ASN.1 KeyDescription extension entirely offline using standard Web Crypto (`crypto.subtle`) without external API calls.
4. **Hardware Cryptographic Binding**: The private signing key never leaves the hardware boundary (Secure Element / TEE). The leaf certificate public key is cryptographically bound to the device record in D1.

---

## 4. Attestation Verification Pipeline

When a device pairs with EdgePay-CF:

```
[ Android Device (TEE / StrongBox) ]
       │
       │ 1. POST /api/mobile/v1/pair/initiate { otp }
       ▼
[ Cloudflare Worker EdgePoP ]
       │  - Validates OTP without consumption
       │  - Generates 32-byte cryptographic random challenge
       │  - Stores in KV: `attest:challenge:{otpHash}` (300s TTL)
       │  - Returns { challenge, expires_in: 300 }
       ▼
[ Android Device ]
       │  - KeyGenParameterSpec.Builder(alias, PURPOSE_SIGN)
       │      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
       │      .setDigests(DIGEST_SHA256)
       │      .setAttestationChallenge(challengeBytes)
       │      .setIsStrongBoxBacked(true / false)
       │      .build()
       │  - Extracts X.509 Certificate Chain from AndroidKeyStore
       │  - POST /api/mobile/v1/pair { otp, public_key, cert_chain }
       ▼
[ Cloudflare Worker EdgePoP ]
       │ 1. Atomic OTP consumption in D1 SQLite
       │ 2. Fetch & immediate delete of KV challenge (single-use guarantee)
       │ 3. Parse X.509 chain (TBS, Validity, Signatures via Web Crypto)
       │ 4. Check root certificate SPKI against Google Pinned Hardware Roots
       │ 5. Parse ASN.1 KeyDescription extension (OID 1.3.6.1.4.1.11129.2.1.17)
       │ 6. Verify challenge matches KV challenge exactly
       │ 7. Verify security level: Reject SOFTWARE (0); accept TEE (1) / StrongBox (2)
       │ 8. Enforce authorization constraints:
       │      - Origin: KM_ORIGIN_GENERATED (0)
       │      - Purpose: KM_PURPOSE_SIGN (2)
       │      - Algorithm: KM_ALGORITHM_EC (3, P-256)
       │      - App Scoping: ALL_APPLICATIONS (600) absent
       │      - Verified Boot: KM_VERIFIED_BOOT_STATE_VERIFIED (0)
       │      - Lock State: deviceLocked == true
       │ 9. Verify leaf cert SPKI matches supplied body.public_key
       │ 10. Persist device record with attestation audit fields in D1
```

---

## 5. Threat Model Mitigations

| Threat | Play Integrity Mitigation | Key Attestation Mitigation |
|---|---|---|
| **Rooted Device / Magisk / KernelSU** | Token marked unverified (often bypassed via Play Integrity Fix modules) | Hardware TEE reports `deviceLocked = false` and `verifiedBootState != VERIFIED`; server rejects. |
| **Emulator / Cloud Android Farm** | Fails device recognition | Attestation Security Level is `KM_SECURITY_LEVEL_SOFTWARE` (0) or fails Google Root signature verification; server rejects. |
| **Private Key Extraction** | N/A (Play Integrity does not manage signing keys) | Hardware private key is non-exportable from Secure Element / TEE; cannot be extracted even with root. |
| **Signature Replay** | Replay protection requires Google nonce | 32-byte single-use server challenge bound into ASN.1 extension leaf cert. Single-use KV delete prevents replay. |
| **Key Substitution / MitM** | Vulnerable if key generation is unhardened | Server verifies that `leafCert.spki` is byte-for-byte identical to the registered `device.public_key`. |

---

## 6. Migration & Policy Rollout

To ensure zero downtime for existing operational merchants during fleet transition, the engine provides progressive security gating:

1. **Default Mode**:
   - `ATTESTATION_REQUIRED=false`: Legacy keyless and software-signed devices continue forwarding SMS.
   - Attested devices record hardware audit metadata in `op_paired_devices`.
2. **Hardened Mode**:
   - `SIGNATURE_REQUIRED=true`: Rejects unsigned SMS forwards with `422 DEVICE_MUST_REPAIR`.
3. **High-Assurance Production Mode**:
   - `ATTESTATION_REQUIRED=true`: All pairing requires valid AOSP Key Attestation chain. Unattested devices rejected with `422 DEVICE_NOT_ATTESTED`.
   - `ATTESTATION_MAX_AGE_DAYS=30`: Requires periodic key renewal; stale attestations rejected with `422 ATTESTATION_STALE`.
   - `STRONGBOX_REQUIRED=true`: Enforces dedicated EAL5+ hardware tamper resistance.
