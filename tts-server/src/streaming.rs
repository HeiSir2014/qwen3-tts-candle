use byteorder::{BigEndian, WriteBytesExt};
use std::io::Cursor;

/// Marker for an audio data chunk.
pub const MARKER_AUDIO: u32 = 0xFFFF_FFFE;
/// Marker for the end-of-stream frame.
pub const MARKER_END: u32 = 0xFFFF_FFFD;
/// Marker for an error frame.
pub const MARKER_ERROR: u32 = 0xFFFF_FFFF;
/// Build a binary frame header + data for the streaming protocol.
///
/// Frame format (all big-endian u32):
/// ```text
/// [chunkIndex: u32][marker: u32][sampleRate: u32][dataLen: u32][data bytes]
/// ```
pub fn build_audio_frame(chunk_index: u32, sample_rate: u32, pcm_data: &[u8]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::with_capacity(16 + pcm_data.len()));
    buf.write_u32::<BigEndian>(chunk_index).unwrap();
    buf.write_u32::<BigEndian>(MARKER_AUDIO).unwrap();
    buf.write_u32::<BigEndian>(sample_rate).unwrap();
    buf.write_u32::<BigEndian>(pcm_data.len() as u32).unwrap();
    let mut result = buf.into_inner();
    result.extend_from_slice(pcm_data);
    result
}

/// Build the end-of-stream frame.
pub fn build_end_frame(total_chunks: u32) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::with_capacity(16));
    buf.write_u32::<BigEndian>(MARKER_END).unwrap();
    buf.write_u32::<BigEndian>(total_chunks).unwrap();
    buf.write_u32::<BigEndian>(0).unwrap();
    buf.write_u32::<BigEndian>(0).unwrap();
    buf.into_inner()
}

/// Build an error frame with a message.
pub fn build_error_frame(message: &str) -> Vec<u8> {
    let msg_bytes = message.as_bytes();
    let mut buf = Cursor::new(Vec::with_capacity(16 + msg_bytes.len()));
    buf.write_u32::<BigEndian>(MARKER_ERROR).unwrap();
    buf.write_u32::<BigEndian>(0).unwrap();
    buf.write_u32::<BigEndian>(0).unwrap();
    buf.write_u32::<BigEndian>(msg_bytes.len() as u32).unwrap();
    let mut result = buf.into_inner();
    result.extend_from_slice(msg_bytes);
    result
}

/// Convert f32 audio samples to i16 PCM bytes (little-endian).
pub fn samples_to_pcm_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let clamped = s.max(-1.0).min(1.0);
        let val = (clamped * 32767.0) as i16;
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    bytes
}
