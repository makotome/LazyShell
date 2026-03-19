use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use pbkdf2::pbkdf2_hmac_array;
use rand::rngs::ThreadRng;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use thiserror::Error;

const PBKDF2_ITERATIONS: u32 = 100_000;
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;

// Domain separator for verify key derivation (different from encryption key)
const VERIFY_DOMAIN: &[u8] = b"LazyShell_VerifyKey_v1";
// Domain separator for encryption key derivation
const ENCRYPT_DOMAIN: &[u8] = b"LazyShell_EncryptKey_v1";

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),
    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("Invalid data format")]
    InvalidFormat,
    #[error("Key derivation failed")]
    KeyDerivationFailed,
    #[error("Auth file error: {0}")]
    AuthError(String),
}

#[derive(Serialize, Deserialize)]
pub struct AuthData {
    pub version: u8,
    pub salt: Vec<u8>,
    pub verify_key_hash: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
pub struct EncryptedData {
    pub version: u8,
    pub salt: Vec<u8>,
    pub nonce: Vec<u8>,
    pub data: Vec<u8>,
}

pub struct EncryptedStorage {
    key: [u8; 32],
}

impl EncryptedStorage {
    pub fn new(master_password: &str) -> Self {
        let mut salt = [0u8; SALT_LEN];
        ThreadRng::fill(&mut ThreadRng::default(), &mut salt);
        let key = derive_key(master_password, &salt);
        Self { key }
    }

    pub fn from_password(master_password: &str, salt: &[u8]) -> Self {
        let key = derive_key(master_password, salt);
        Self { key }
    }

    pub fn get_salt(&self) -> [u8; SALT_LEN] {
        let mut salt = [0u8; SALT_LEN];
        ThreadRng::fill(&mut ThreadRng::default(), &mut salt);
        salt
    }

    pub fn encrypt(&self, plaintext: &[u8], salt: &[u8]) -> Result<EncryptedData, CryptoError> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        ThreadRng::fill(&mut ThreadRng::default(), &mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        Ok(EncryptedData {
            version: 1,
            salt: salt.to_vec(),
            nonce: nonce_bytes.to_vec(),
            data: ciphertext,
        })
    }

    pub fn decrypt(&self, encrypted: &EncryptedData) -> Result<Vec<u8>, CryptoError> {
        if encrypted.version != 1 {
            return Err(CryptoError::InvalidFormat);
        }

        let nonce = Nonce::from_slice(&encrypted.nonce);
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        cipher
            .decrypt(nonce, encrypted.data.as_ref())
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
    }
}

// Main key derivation function - used for encrypting server configs
// Uses PBKDF2 with no domain separator for backward compatibility
pub fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), salt, PBKDF2_ITERATIONS)
}

// Derive verify key using a different domain separator
fn derive_verify_key(password: &str, salt: &[u8]) -> [u8; 32] {
    // Combine salt with domain separator for verify key derivation
    let mut combined_salt = salt.to_vec();
    combined_salt.extend_from_slice(VERIFY_DOMAIN);
    let verify_salt = combined_salt.as_slice();
    pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), verify_salt, PBKDF2_ITERATIONS)
}

// Derive encryption key using a different domain separator
fn derive_encrypt_key(password: &str, salt: &[u8]) -> [u8; 32] {
    // Combine salt with domain separator for encrypt key derivation
    let mut combined_salt = salt.to_vec();
    combined_salt.extend_from_slice(ENCRYPT_DOMAIN);
    let encrypt_salt = combined_salt.as_slice();
    pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), encrypt_salt, PBKDF2_ITERATIONS)
}

// Hash verify key for storage (one-way)
fn hash_verify_key(key: &[u8]) -> [u8; 32] {
    Sha256::digest(key).into()
}

pub fn get_auth_file_path() -> Result<std::path::PathBuf, String> {
    let data_dir = dirs::data_local_dir().ok_or("Failed to get data directory")?;
    let app_dir = data_dir.join("LazyShell");
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    Ok(app_dir.join("auth.bin"))
}

pub fn auth_file_exists() -> bool {
    get_auth_file_path().map(|p| p.exists()).unwrap_or(false)
}

// Save auth data to file
pub fn save_auth_data(auth_data: &AuthData) -> Result<(), CryptoError> {
    let path = get_auth_file_path().map_err(|e| CryptoError::AuthError(e))?;
    let mut file = std::fs::File::create(&path)
        .map_err(|e| CryptoError::AuthError(e.to_string()))?;

    // Write version (1 byte)
    std::io::Write::write_all(&mut file, &[auth_data.version])
        .map_err(|e| CryptoError::AuthError(e.to_string()))?;

    // Write salt length (4 bytes) + salt
    let salt_len = (auth_data.salt.len() as u32).to_le_bytes();
    std::io::Write::write_all(&mut file, &salt_len)
        .map_err(|e| CryptoError::AuthError(e.to_string()))?;
    std::io::Write::write_all(&mut file, &auth_data.salt)
        .map_err(|e| CryptoError::AuthError(e.to_string()))?;

    // Write verify_key_hash
    std::io::Write::write_all(&mut file, &auth_data.verify_key_hash)
        .map_err(|e| CryptoError::AuthError(e.to_string()))?;

    Ok(())
}

// Load auth data from file
pub fn load_auth_data() -> Result<AuthData, CryptoError> {
    let path = get_auth_file_path().map_err(|e| CryptoError::AuthError(e))?;
    let mut file = std::fs::File::open(&path)
        .map_err(|e| CryptoError::AuthError(e.to_string()))?;

    let mut buffer = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut buffer)
        .map_err(|e| CryptoError::AuthError(e.to_string()))?;

    if buffer.len() < 37 {
        return Err(CryptoError::InvalidFormat);
    }

    let mut offset = 0;

    // Read version
    let version = buffer[offset];
    offset += 1;

    // Read salt length
    let salt_len = u32::from_le_bytes([buffer[offset], buffer[offset+1], buffer[offset+2], buffer[offset+3]]) as usize;
    offset += 4;

    // Read salt
    if buffer.len() < offset + salt_len {
        return Err(CryptoError::InvalidFormat);
    }
    let salt = buffer[offset..offset + salt_len].to_vec();
    offset += salt_len;

    // Read verify_key_hash (32 bytes)
    if buffer.len() < offset + 32 {
        return Err(CryptoError::InvalidFormat);
    }
    let verify_key_hash = buffer[offset..offset + 32].to_vec();

    Ok(AuthData {
        version,
        salt,
        verify_key_hash,
    })
}

// Verify password against stored auth data
pub fn verify_password(password: &str) -> Result<bool, CryptoError> {
    let auth_data = load_auth_data()?;

    // Derive verify key from password
    let derived_verify_key = derive_verify_key(password, &auth_data.salt);

    // Hash the derived key
    let hashed_key = hash_verify_key(&derived_verify_key);

    // Compare with stored hash
    Ok(hashed_key[..] == auth_data.verify_key_hash[..])
}

// Setup new master password
pub fn setup_password(password: &str) -> Result<(), CryptoError> {
    // Generate random salt
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::ThreadRng::fill(&mut rand::rngs::ThreadRng::default(), &mut salt);

    // Derive verify key
    let verify_key = derive_verify_key(password, &salt);

    // Hash verify key for storage
    let verify_key_hash = hash_verify_key(&verify_key);

    let auth_data = AuthData {
        version: 1,
        salt: salt.to_vec(),
        verify_key_hash: verify_key_hash.to_vec(),
    };

    save_auth_data(&auth_data)?;

    Ok(())
}

// Get encryption key for decrypting server config (call after password verification)
pub fn get_encryption_key(password: &str, salt: &[u8]) -> [u8; 32] {
    derive_encrypt_key(password, salt)
}

pub fn encrypt_server_config<T: Serialize>(
    config: &T,
    master_password: &str,
) -> Result<Vec<u8>, CryptoError> {
    let plaintext = serde_json::to_vec(config).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let mut salt = [0u8; SALT_LEN];
    ThreadRng::fill(&mut ThreadRng::default(), &mut salt);

    let storage = EncryptedStorage::from_password(master_password, &salt);
    let encrypted = storage.encrypt(&plaintext, &salt)?;

    serde_json::to_vec(&encrypted).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))
}

pub fn decrypt_server_config<T: for<'de> Deserialize<'de>>(
    data: &[u8],
    master_password: &str,
) -> Result<T, CryptoError> {
    let encrypted: EncryptedData =
        serde_json::from_slice(data).map_err(|_| CryptoError::InvalidFormat)?;

    let salt = encrypted.salt.as_slice();
    let storage = EncryptedStorage::from_password(master_password, salt);
    let plaintext = storage.decrypt(&encrypted)?;

    serde_json::from_slice(&plaintext).map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt() {
        #[derive(Serialize, Deserialize, Debug, PartialEq)]
        struct TestConfig {
            name: String,
            host: String,
        }

        let config = TestConfig {
            name: "test-server".to_string(),
            host: "192.168.1.1".to_string(),
        };

        let password = "test-password";
        let encrypted = encrypt_server_config(&config, password).unwrap();
        let decrypted: TestConfig = decrypt_server_config(&encrypted, password).unwrap();

        assert_eq!(config, decrypted);
    }

    #[test]
    fn test_wrong_password() {
        #[derive(Serialize, Deserialize, Debug, PartialEq)]
        struct TestConfig {
            name: String,
        }

        let config = TestConfig {
            name: "test".to_string(),
        };

        let encrypted = encrypt_server_config(&config, "correct-password").unwrap();
        let result: Result<TestConfig, _> = decrypt_server_config(&encrypted, "wrong-password");

        assert!(result.is_err());
    }
}
