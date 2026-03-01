use std::path::Path;

use anyhow::Result;
use candle_core::{DType, Device, Tensor};
use serde::{Deserialize, Serialize};

/// Serializable representation of a voice clone prompt.
/// Stored as bincode in .bin files.
#[derive(Serialize, Deserialize, Clone)]
pub struct SerializablePrompt {
    /// Speaker embedding as f32 values.
    pub speaker_embedding: Vec<f32>,
    /// Reference codec codes (flattened), shape [T, 16]. None for x_vector_only mode.
    pub ref_codes: Option<Vec<i64>>,
    /// Number of frames (T dimension) for ref_codes.
    pub ref_codes_frames: Option<usize>,
    /// Tokenized reference text IDs for ICL mode.
    pub ref_text_ids: Option<Vec<u32>>,
    /// Reference text string (for display/debug).
    pub ref_text: Option<String>,
    /// Format version.
    pub version: u32,
}

impl SerializablePrompt {
    pub const VERSION: u32 = 1;

    /// Convert a qwen3_tts::VoiceClonePrompt to a serializable form.
    pub fn from_prompt(
        prompt: &qwen3_tts::VoiceClonePrompt,
        ref_text: Option<&str>,
    ) -> Result<Self> {
        let speaker_embedding: Vec<f32> = prompt
            .speaker_embedding
            .to_dtype(DType::F32)?
            .flatten_all()?
            .to_vec1()?;

        let (ref_codes, ref_codes_frames) = if let Some(codes) = &prompt.ref_codes {
            let (frames, _codebooks) = codes.dims2()?;
            let flat: Vec<i64> = codes.to_dtype(DType::I64)?.flatten_all()?.to_vec1()?;
            (Some(flat), Some(frames))
        } else {
            (None, None)
        };

        Ok(Self {
            speaker_embedding,
            ref_codes,
            ref_codes_frames,
            ref_text_ids: prompt.ref_text_ids.clone(),
            ref_text: ref_text.map(|s| s.to_string()),
            version: Self::VERSION,
        })
    }

    /// Convert back to a qwen3_tts::VoiceClonePrompt.
    pub fn to_prompt(&self, device: &Device) -> Result<qwen3_tts::VoiceClonePrompt> {
        let speaker_embedding =
            Tensor::from_vec(self.speaker_embedding.clone(), self.speaker_embedding.len(), device)?;

        let ref_codes = if let (Some(codes), Some(frames)) = (&self.ref_codes, self.ref_codes_frames)
        {
            let codebooks = codes.len() / frames;
            let tensor = Tensor::from_vec(codes.clone(), (frames, codebooks), device)?;
            Some(tensor)
        } else {
            None
        };

        Ok(qwen3_tts::VoiceClonePrompt {
            speaker_embedding,
            ref_codes,
            ref_text_ids: self.ref_text_ids.clone(),
        })
    }

    /// Save to a .bin file using bincode.
    pub fn save(&self, path: &Path) -> Result<()> {
        let encoded = bincode::serialize(self)?;
        std::fs::write(path, encoded)?;
        Ok(())
    }

    /// Load from a .bin file.
    pub fn load(path: &Path) -> Result<Self> {
        let data = std::fs::read(path)?;
        let prompt: Self = bincode::deserialize(&data)?;
        Ok(prompt)
    }
}
