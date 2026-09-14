/**
 * Google Hardware Attestation Root Keys & Certificates.
 *
 * Sources:
 * 1. Google Hardware Attestation Root (Legacy RSA 4096-bit SPKI)
 *    https://developer.android.com/privacy-and-security/security-key-attestation
 * 2. Google RKP Hardware Attestation Root (Remote Key Provisioning EC P-256 SPKI)
 * 3. Google Official Test Root Certificate (Self-signed 4096-bit root for local & unit test validation)
 */

/**
 * Google Hardware Attestation Root Public Key (RSA 4096-bit SPKI, base64-encoded).
 * Every compliant Android 7.0+ device's hardware-backed attestation chain terminates
 * at a root signed by or matching this key.
 */
export const GOOGLE_ROOT_RSA_PUBKEY_B64 =
  'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xU' +
  'FmOr75gvMsd/dTEDDJdSSxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5j' +
  'lRfdnJLmN0pTy/4lj4/7tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y' +
  '//0rb+T+W8a9nsNL/ggjnar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73X' +
  'pXyTqRxB/M0n1n/W9nGqC4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYI' +
  'mQQcHtGl/m00QLVWutHQoVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB' +
  '+TxywElgS70vE0XmLD+OJtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7q' +
  'uvmag8jfPioyKvxnK/EgsTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgp' +
  'Zrt3i5MIlCaY504LzSRiigHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7' +
  'gLiMm0jhO2B6tUXHI/+MRPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82' +
  'ixPvZtXQpUpuL12ab+9EaDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+' +
  'NpUFgNPN9PvQi8WEg5UmAGMCAwEAAQ==';

/**
 * Google RKP (Remote Key Provisioning) Hardware Attestation Root Public Key
 * (ECDSA P-384 / secp384r1 SPKI, base64-encoded).
 *
 * Source: https://android.googleapis.com/attestation/root (Certificate 1)
 * Subject: CN=Key Attestation CA1, OU=Android, O=Google LLC, C=US
 * Validity: 2025-07-17 to 2035-07-15
 * SPKI Length: 120 bytes
 * SHA-256: 3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec
 */
export const GOOGLE_ROOT_RKP_PUBKEY_B64 =
  'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEI9ojcU7fPlsFCjxy6IRqzgeOoK0b+YsV' +
  '9FPQywiyw8EQRTkJ9u3qwfnI4DGoSLlBqClTXJfgfCcZvs60FikNMHnu4fkRzObf' +
  'gDkU2KNXezT9/RQ+XvNslxPHrHCowhGr';

/**
 * Google Official Test Root Certificate (base64 DER).
 * Distributed in Google's AOSP test suite for offline verification tests.
 */
export const GOOGLE_TEST_ROOT_CERT_B64 =
  'MIIFXzCCA0egAwIBAgIINQWgov3MUeQwDQYJKoZIhvcNAQELBQAwGzEZMBcGA1UEBRMQZTM1ZDM4' +
  'YzY4OTdkNDdlODAeFw0xODAzMjEwMzU1MDFaFw0yODAzMTgwMzU1MDFaMBsxGTAXBgNVBAUTEGUz' +
  'NWQzOGM2ODk3ZDQ3ZTgwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCoQi070/6PH9BA' +
  'uJiBcTp8j5R2/Fj6kXFaSxsvUjJKRdi/FCOwUFBJfyhHiWJhga2iguIjAJuhZx5XlMj0pSY7buJi' +
  'sPqFknZhKdvfoi4C54j54D+XxCky1APVjD5uc203H+hrRlhh6x4/LTzSXWvb0YLjfOK07HvSddSR' +
  'CyKnPydI5bhyCb5QMtVKHzC4Axgx+BihwG1B4UQjOpZpXBHIFZ6EK/XBFeJX0tgrx0MCczkc1X0O' +
  'hNFKAYumCKcKyh4q2cGh7UwTRJIT4beIJVrOKDVwo3Fc50k3ICpOAc1zRGzRwupIKKGtW455KW1O' +
  'IyAtTJ4NqfIwrkQy5EJ9w/zDzjqFiDNdgTXaMtsz52jHUndfO3lzfvVdBjt2FWLRkWrFmd1tjQ6L' +
  'QQFPrSvUHo0XN5kIiOYdNlAyIwBZ51Zn/clU9he78UYAmXHdjfh04DXWgf+GGIFFdmg9tbiHwdqi' +
  '8yEcakKHL2TYNylmFJuKOkvLIS5iqEMu29OQyv+BJ1NNQtyn8o1D5f3K2a5qyoUcrL0Je2w28ByL' +
  '1JeFURO7wbzkXx9FWwH0stCs/dYq4JKJ8GxKN8aBOl/51atA1cdZAyI55B9ueAYwPevteORGDhEf' +
  'cKRaGiWJpSzIFLDmbL9uSpCAw5uqx5h1IRAX1OLi56EsVaFUedt8IqUaCkUcMQIDAQABo4GmMIGj' +
  'MB0GA1UdDgQWBBRTDkUbExXTrVzqjui8W7YUis0d6DAfBgNVHSMEGDAWgBRTDkUbExXTrVzqjui8' +
  'W7YUis0d6DAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDBABgNVHR8EOTA3MDWgM6Ax' +
  'hi9odHRwczovL2FuZHJvaWQuZ29vZ2xlYXBpcy5jb20vYXR0ZXN0YXRpb24vY3JsLzANBgkqhkiG' +
  '9w0BAQsFAAOCAgEACHPElcXZEY6jItn3SnVn6gdOCvuFIrhB4J4fhxa6OlDCbxsylHHAbpyoOSJD' +
  '0R5dIBTRvz49ElfCpI9yp4l5tUOjWj2K3tMfQjhKN277jApdxbZ6MNac2u+Z3dwS+34YiiCJLVKh' +
  'VzWanXk/+9rmVnBzm7qvgan90j2SmH1oYIA3GowJL+1OWSjj6cBH1VrU7guVd7q+aCEQPhTesfbm' +
  'UkdUbM/TjUMyhf5SZ7WB8A28MnyYQcFttmGDsE1HZx4fTz8iXxjaph33alasmFUWGtG7KyzvbYUw' +
  'wUOmpPd32eT8ocx3B0Z3g+Vo2Cv2LzRRNp15FOf/Ag5HWloyIv3xrsBA2fa4xzOm3/t1Aq0ZViXL' +
  'LerKKmU/EJKo7t5gE0wtNebicNhUJaX2C+vShjfleBBwhs33a8b7dBFX/JMwU5+09N83WHRPZjCr' +
  'YuK3Uu4qANfJ+f1k+weqh6MpRxAZ6TT0OQt1XQz7rDAlq7AopfXRXI74OCNJf8d+2CPNVW8i5IHN' +
  'FjvyEz8ms1ETdw5n3uRbYIgYuCV2Pud3MCwaMTv2E0dLAqg8uJo0JYlhH7wbqidMm2ODRL5FaqWb' +
  'b2pfW0vbpCyGfyw0RQGTJAE7xVdvzfdun9HATDm6TbJFcejBdJImfwpZmDOBtDPIbsg5+QVE3lLF' +
  '6Licq13i5tIg5yQ=';
