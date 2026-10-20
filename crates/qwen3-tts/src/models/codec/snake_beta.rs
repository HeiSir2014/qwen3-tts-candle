//! SnakeBeta Activation Function
//!
//! A modified Snake activation with separate trainable parameters for
//! frequency (alpha) and magnitude (beta).
//!
//! Formula: x + (1/β) * sin²(α * x)
//! where α = exp(alpha_param) and β = exp(beta_param)

use anyhow::Result;
use candle_core::{Module, Tensor};
use candle_nn::VarBuilder;

/// SnakeBeta activation function
///
/// Reference: "Neural Networks Fail to Learn Periodic Functions and How to Fix It"
/// (<https://arxiv.org/abs/2006.08195>)
pub struct SnakeBeta {
    /// `exp(alpha)`, shape `[channels]`
    alpha: Tensor,
    /// `1 / (exp(beta) + epsilon)`, shape `[channels]`
    inv_beta: Tensor,
}

/// Small constant to prevent division by zero
const EPSILON: f64 = 1e-9;

impl SnakeBeta {
    /// Create a new SnakeBeta activation.
    ///
    /// # Arguments
    /// * `channels` - Number of channels (alpha and beta have shape `[channels]`)
    /// * `vb` - Variable builder for loading weights
    pub fn new(channels: usize, vb: VarBuilder) -> Result<Self> {
        let alpha = vb.get((channels,), "alpha")?;
        let beta = vb.get((channels,), "beta")?;
        Self::from_weights(alpha, beta)
    }

    /// Create from raw weight tensors.
    ///
    /// Alpha and beta should have shape `[channels]`. The exponentiated
    /// parameters are precomputed once here rather than on every call.
    pub fn from_weights(alpha: Tensor, beta: Tensor) -> Result<Self> {
        Ok(Self {
            alpha: alpha.exp()?,
            inv_beta: (beta.exp()? + EPSILON)?.recip()?,
        })
    }

    /// Forward pass.
    ///
    /// Input shape: [batch, channels, seq_len]
    /// Output shape: [batch, channels, seq_len]
    pub fn forward(&self, x: &Tensor) -> Result<Tensor> {
        // On Metal one fused kernel replaces five full-size elementwise passes.
        #[cfg(feature = "metal")]
        if x.device().is_metal() && x.dtype() == candle_core::DType::F32 {
            return Ok(x.contiguous()?.apply_op3_no_bwd(
                &self.alpha,
                &self.inv_beta,
                &crate::models::metal_ops::SnakeBetaOp,
            )?);
        }

        // Reshape alpha and 1/beta for broadcasting: [channels] -> [1, channels, 1]
        let alpha = self.alpha.unsqueeze(0)?.unsqueeze(2)?;
        let inv_beta = self.inv_beta.unsqueeze(0)?.unsqueeze(2)?;

        // x + (1/beta) * sin²(alpha * x)
        let sin_term = x.broadcast_mul(&alpha)?.sin()?.sqr()?;
        Ok((x + sin_term.broadcast_mul(&inv_beta)?)?)
    }
}

impl Module for SnakeBeta {
    fn forward(&self, x: &Tensor) -> candle_core::Result<Tensor> {
        SnakeBeta::forward(self, x).map_err(|e| candle_core::Error::Msg(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::{DType, Device};

    #[test]
    fn test_snake_beta_shape() {
        let device = Device::Cpu;

        // Create alpha and beta with zeros (will exp to 1.0)
        let alpha = Tensor::zeros((64,), DType::F32, &device).unwrap();
        let beta = Tensor::zeros((64,), DType::F32, &device).unwrap();

        let snake = SnakeBeta::from_weights(alpha, beta).unwrap();

        let input = Tensor::randn(0.0f32, 1.0, (2, 64, 100), &device).unwrap();
        let output = snake.forward(&input).unwrap();

        assert_eq!(output.dims(), &[2, 64, 100]);
    }

    #[test]
    fn test_snake_beta_output_range() {
        let device = Device::Cpu;

        // With alpha=beta=0, we get exp(0)=1, so:
        // output = x + sin²(x), which is bounded by x + 1
        let alpha = Tensor::zeros((4,), DType::F32, &device).unwrap();
        let beta = Tensor::zeros((4,), DType::F32, &device).unwrap();

        let snake = SnakeBeta::from_weights(alpha, beta).unwrap();

        // Input in range [-1, 1]
        let input = Tensor::new(&[[[0.0f32, 0.5, -0.5, 1.0]]], &device)
            .unwrap()
            .broadcast_as((1, 4, 4))
            .unwrap();

        let output = snake.forward(&input).unwrap();

        // Output should be >= input (since we're adding a non-negative term)
        let input_sum: f32 = input.sum_all().unwrap().to_scalar().unwrap();
        let output_sum: f32 = output.sum_all().unwrap().to_scalar().unwrap();

        // sin²(x) is always >= 0, so output >= input
        assert!(output_sum >= input_sum - 0.01);
    }

    /// The fused Metal kernel must match the tensor-op path on CPU.
    #[cfg(feature = "metal")]
    #[test]
    fn test_snake_beta_metal_matches_cpu() {
        let Ok(metal) = Device::new_metal(0) else {
            return;
        };
        let cpu = Device::Cpu;
        let alpha = Tensor::randn(0.0f32, 0.5, (16,), &cpu).unwrap();
        let beta = Tensor::randn(0.0f32, 0.5, (16,), &cpu).unwrap();
        // Large inputs exercise sin range reduction.
        let input = Tensor::randn(0.0f32, 20.0, (2, 16, 333), &cpu).unwrap();

        let expected = SnakeBeta::from_weights(alpha.clone(), beta.clone())
            .unwrap()
            .forward(&input)
            .unwrap();
        let actual = SnakeBeta::from_weights(
            alpha.to_device(&metal).unwrap(),
            beta.to_device(&metal).unwrap(),
        )
        .unwrap()
        .forward(&input.to_device(&metal).unwrap())
        .unwrap()
        .to_device(&cpu)
        .unwrap();

        let diff: f32 = (&expected - &actual)
            .unwrap()
            .abs()
            .unwrap()
            .flatten_all()
            .unwrap()
            .max(0)
            .unwrap()
            .to_scalar()
            .unwrap();
        assert!(diff < 1e-4, "metal vs cpu max diff {diff}");
    }

    #[test]
    fn test_snake_beta_trainable_params() {
        let device = Device::Cpu;

        // Test that different alpha/beta give different outputs
        let alpha1 = Tensor::zeros((4,), DType::F32, &device).unwrap();
        let beta1 = Tensor::zeros((4,), DType::F32, &device).unwrap();

        let alpha2 = Tensor::ones((4,), DType::F32, &device).unwrap();
        let beta2 = Tensor::ones((4,), DType::F32, &device).unwrap();

        let snake1 = SnakeBeta::from_weights(alpha1, beta1).unwrap();
        let snake2 = SnakeBeta::from_weights(alpha2, beta2).unwrap();

        let input = Tensor::randn(0.0f32, 1.0, (1, 4, 10), &device).unwrap();

        let out1 = snake1.forward(&input).unwrap();
        let out2 = snake2.forward(&input).unwrap();

        // Outputs should differ
        let diff: f32 = (&out1 - &out2)
            .unwrap()
            .abs()
            .unwrap()
            .sum_all()
            .unwrap()
            .to_scalar()
            .unwrap();

        assert!(diff > 0.0);
    }
}
