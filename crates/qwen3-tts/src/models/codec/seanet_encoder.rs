//! SEANet encoder of the 12Hz speech tokenizer (Mimi architecture).
//!
//! Same computation as `candle_transformers::models::mimi::seanet::SeaNetEncoder`
//! (causal, constant padding, one residual unit per stage, identity skips),
//! but every conv runs through [`conv1d_stacked_taps`]: the encoder works at
//! 24 kHz, where candle's im2col-based conv1d dominates prompt extraction
//! time on Metal.

use anyhow::Result;
use candle_core::Tensor;
use candle_nn::VarBuilder;

use super::causal_conv::{conv1d_stacked_taps, tap_major_weight};

/// Mimi v0.1 SEANet hyper-parameters used by the Qwen3-TTS 12Hz tokenizer.
const N_FILTERS: usize = 64;
const KERNEL_SIZE: usize = 7;
const RESIDUAL_KERNEL_SIZE: usize = 3;
const LAST_KERNEL_SIZE: usize = 3;
const COMPRESS: usize = 2;
/// Downsampling ratios in application order (config lists them reversed).
const RATIOS: [usize; 4] = [4, 5, 6, 8];
const ELU_ALPHA: f64 = 1.0;

/// Causal conv with Mimi's `StreamableConv1d` padding: `k - stride` zeros on
/// the left plus enough on the right to cover the last full window.
struct EncoderConv {
    gemm_weight: Tensor,
    kernel_size: usize,
    stride: usize,
}

impl EncoderConv {
    fn new(
        in_c: usize,
        out_c: usize,
        kernel_size: usize,
        stride: usize,
        vb: VarBuilder,
    ) -> Result<Self> {
        let weight = vb.get((out_c, in_c, kernel_size), "weight")?;
        let bias = vb.get(out_c, "bias")?;
        Ok(Self {
            gemm_weight: tap_major_weight(&weight, Some(&bias))?,
            kernel_size,
            stride,
        })
    }

    fn forward(&self, x: &Tensor) -> Result<Tensor> {
        let len = x.dim(2)?;
        let padding_total = self.kernel_size - self.stride;
        let n_frames = (len + padding_total).saturating_sub(self.kernel_size) as f64
            / self.stride as f64
            + 1.0;
        let ideal_len = ((n_frames.ceil() as usize - 1) * self.stride + self.kernel_size)
            .saturating_sub(padding_total);
        let extra_padding = ideal_len.saturating_sub(len);
        let x = x.pad_with_zeros(2, padding_total, extra_padding)?;
        conv1d_stacked_taps(&x, &self.gemm_weight, self.kernel_size, self.stride, 1)
    }
}

/// `x + conv1x1(elu(conv_k(elu(x))))`
struct ResidualUnit {
    conv1: EncoderConv,
    conv2: EncoderConv,
}

impl ResidualUnit {
    fn forward(&self, x: &Tensor) -> Result<Tensor> {
        let h = self.conv1.forward(&x.elu(ELU_ALPHA)?)?;
        let h = self.conv2.forward(&h.elu(ELU_ALPHA)?)?;
        Ok((h + x)?)
    }
}

struct EncoderStage {
    residual: ResidualUnit,
    downsample: EncoderConv,
}

/// SEANet encoder: `[1, 1, samples]` audio to `[1, dimension, frames]`.
pub struct SeaNetEncoder {
    init_conv: EncoderConv,
    stages: Vec<EncoderStage>,
    final_conv: EncoderConv,
}

impl SeaNetEncoder {
    /// Load from the tokenizer's `encoder.encoder.*` weights (`vb` points at
    /// `encoder`); `dimension` is the output channel count.
    pub fn new(dimension: usize, vb: VarBuilder) -> Result<Self> {
        let vb = vb.pp("layers");
        let init_conv = EncoderConv::new(1, N_FILTERS, KERNEL_SIZE, 1, vb.pp(0).pp("conv"))?;

        // Layer indices follow Mimi's nn.Sequential: per stage one residual
        // block, an activation, then the downsampling conv.
        let mut layer_idx = 1;
        let mut channels = N_FILTERS;
        let mut stages = Vec::with_capacity(RATIOS.len());
        for ratio in RATIOS {
            let block = vb.pp(layer_idx).pp("block");
            let hidden = channels / COMPRESS;
            let residual = ResidualUnit {
                conv1: EncoderConv::new(
                    channels,
                    hidden,
                    RESIDUAL_KERNEL_SIZE,
                    1,
                    block.pp(1).pp("conv"),
                )?,
                conv2: EncoderConv::new(hidden, channels, 1, 1, block.pp(3).pp("conv"))?,
            };
            let downsample = EncoderConv::new(
                channels,
                channels * 2,
                ratio * 2,
                ratio,
                vb.pp(layer_idx + 2).pp("conv"),
            )?;
            stages.push(EncoderStage {
                residual,
                downsample,
            });
            layer_idx += 3;
            channels *= 2;
        }

        let final_conv = EncoderConv::new(
            channels,
            dimension,
            LAST_KERNEL_SIZE,
            1,
            vb.pp(layer_idx + 1).pp("conv"),
        )?;
        Ok(Self {
            init_conv,
            stages,
            final_conv,
        })
    }

    pub fn forward(&self, audio: &Tensor) -> Result<Tensor> {
        let mut x = self.init_conv.forward(audio)?;
        for stage in &self.stages {
            x = stage.residual.forward(&x)?;
            x = stage.downsample.forward(&x.elu(ELU_ALPHA)?)?;
        }
        self.final_conv.forward(&x.elu(ELU_ALPHA)?)
    }
}
