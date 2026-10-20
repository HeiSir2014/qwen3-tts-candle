//! Causal 1D Convolution
//!
//! A Conv1d that only looks at past context by padding on the left.
//! This ensures the output at position t depends only on inputs at positions <= t.

use anyhow::Result;
use candle_core::{Module, Tensor};
use candle_nn::{conv1d, Conv1d, Conv1dConfig, VarBuilder};

/// Causal 1D Convolution
///
/// Pads the input on the left side to ensure causality.
/// The padding amount is `dilation * (kernel_size - 1)`.
pub struct CausalConv1d {
    conv: Conv1d,
    /// Left padding to add before convolution
    causal_padding: usize,
    /// For ungrouped convs: weight as `[out, kernel * in]` (tap-major) so the
    /// conv is one matmul over the stacked input taps.
    gemm_weight: Option<Tensor>,
}

/// Left context carried between streaming calls of a [`CausalConv1d`]: the
/// last `causal_padding` input samples. `None` means zeros (stream start).
pub type CausalConvState = Option<Tensor>;

impl CausalConv1d {
    /// Create a new causal conv1d layer.
    ///
    /// # Arguments
    /// * `in_channels` - Number of input channels
    /// * `out_channels` - Number of output channels
    /// * `kernel_size` - Size of the convolving kernel
    /// * `dilation` - Spacing between kernel elements (default 1)
    /// * `vb` - Variable builder for loading weights
    pub fn new(
        in_channels: usize,
        out_channels: usize,
        kernel_size: usize,
        dilation: usize,
        vb: VarBuilder,
    ) -> Result<Self> {
        // Conv with no padding - we'll handle padding manually
        let config = Conv1dConfig {
            padding: 0,
            stride: 1,
            dilation,
            groups: 1,
            ..Default::default()
        };

        let conv = conv1d(in_channels, out_channels, kernel_size, config, vb)?;
        Self::from_conv(conv)
    }

    /// Create from raw weight and bias tensors.
    ///
    /// Weight should have shape [out_channels, in_channels, kernel_size].
    pub fn from_weights(weight: Tensor, bias: Option<Tensor>, dilation: usize) -> Result<Self> {
        Self::from_weights_grouped(weight, bias, dilation, 1)
    }

    /// Create from raw weight and bias tensors with grouped convolution.
    ///
    /// Weight should have shape [out_channels, in_channels/groups, kernel_size].
    /// For depthwise conv, groups = in_channels = out_channels.
    pub fn from_weights_grouped(
        weight: Tensor,
        bias: Option<Tensor>,
        dilation: usize,
        groups: usize,
    ) -> Result<Self> {
        let config = Conv1dConfig {
            padding: 0,
            stride: 1,
            dilation,
            groups,
            ..Default::default()
        };

        let conv = Conv1d::new(weight, bias, config);
        Self::from_conv(conv)
    }

    fn from_conv(conv: Conv1d) -> Result<Self> {
        let (c_out, c_in, kernel_size) = conv.weight().dims3()?;
        let causal_padding = conv.config().dilation * (kernel_size - 1);
        let gemm_weight = if conv.config().groups == 1 {
            Some(
                conv.weight()
                    .permute((0, 2, 1))?
                    .contiguous()?
                    .reshape((c_out, kernel_size * c_in))?,
            )
        } else {
            None
        };
        Ok(Self {
            conv,
            causal_padding,
            gemm_weight,
        })
    }

    /// Forward pass with causal (left-only) padding.
    ///
    /// Input shape: [batch, in_channels, seq_len]
    /// Output shape: [batch, out_channels, seq_len]
    pub fn forward(&self, x: &Tensor) -> Result<Tensor> {
        self.forward_with_state(x, &mut None)
    }

    /// Streaming forward: uses `state` as left context instead of zeros and
    /// replaces it with the tail of this call's input, so feeding a sequence
    /// in chunks gives the same output as one [`Self::forward`] call.
    pub fn forward_with_state(&self, x: &Tensor, state: &mut CausalConvState) -> Result<Tensor> {
        let pad = self.causal_padding;
        if pad == 0 {
            return self.conv1d(x);
        }
        let x_padded = match state.take() {
            Some(prev) => Tensor::cat(&[&prev, x], 2)?,
            None => x.pad_with_zeros(2, pad, 0)?,
        };
        let len = x_padded.dim(2)?;
        *state = Some(x_padded.narrow(2, len - pad, pad)?.contiguous()?);
        self.conv1d(&x_padded)
    }

    /// Unpadded convolution.
    ///
    /// Ungrouped convs stack the `kernel` shifted input views along channels
    /// and run one matmul that writes `[batch, out, time]` directly; candle's
    /// conv1d goes through im2col in time-major layout plus an output
    /// transpose, which is several times slower on Metal. Depthwise convs are
    /// a sum of per-tap scaled shifts, since candle runs grouped convs as one
    /// conv per group, i.e. thousands of tiny kernels for a 1024-channel
    /// depthwise conv.
    fn conv1d(&self, x: &Tensor) -> Result<Tensor> {
        let config = self.conv.config();
        let weight = self.conv.weight();
        let (c_out, c_in_per_group, k) = weight.dims3()?;
        let out_len = x.dim(2)? - config.dilation * (k - 1);
        if let Some(gemm_weight) = &self.gemm_weight {
            let cols = if k == 1 {
                x.clone()
            } else {
                let taps = (0..k)
                    .map(|tap| x.narrow(2, tap * config.dilation, out_len))
                    .collect::<candle_core::Result<Vec<_>>>()?;
                Tensor::cat(&taps, 1)?
            };
            let y = gemm_weight.broadcast_matmul(&cols)?;
            return Ok(match self.conv.bias() {
                Some(bias) => y.broadcast_add(&bias.reshape((1, c_out, 1))?)?,
                None => y,
            });
        }
        if c_in_per_group != 1 || c_out != config.groups {
            return Ok(self.conv.forward(x)?);
        }
        let weight = weight.reshape((1, c_out, k))?;
        let mut y = match self.conv.bias() {
            Some(bias) => x
                .narrow(2, 0, out_len)?
                .broadcast_mul(&weight.narrow(2, 0, 1)?)?
                .broadcast_add(&bias.reshape((1, c_out, 1))?)?,
            None => x
                .narrow(2, 0, out_len)?
                .broadcast_mul(&weight.narrow(2, 0, 1)?)?,
        };
        for tap in 1..k {
            let shifted = x.narrow(2, tap * config.dilation, out_len)?;
            y = (y + shifted.broadcast_mul(&weight.narrow(2, tap, 1)?)?)?;
        }
        Ok(y)
    }
}

impl Module for CausalConv1d {
    fn forward(&self, x: &Tensor) -> candle_core::Result<Tensor> {
        CausalConv1d::forward(self, x).map_err(|e| candle_core::Error::Msg(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::{DType, Device};
    use candle_nn::VarMap;

    fn create_mock_vb(device: &Device) -> VarBuilder<'static> {
        let varmap = VarMap::new();
        VarBuilder::from_varmap(&varmap, DType::F32, device)
    }

    #[test]
    fn test_causal_conv_construction() {
        let device = Device::Cpu;
        let vb = create_mock_vb(&device);
        let conv = CausalConv1d::new(64, 128, 3, 1, vb).unwrap();
        assert_eq!(conv.causal_padding, 2); // dilation * (kernel_size - 1) = 1 * (3 - 1) = 2
    }

    #[test]
    fn test_causal_conv_dilation() {
        let device = Device::Cpu;
        let vb = create_mock_vb(&device);
        let conv = CausalConv1d::new(32, 32, 3, 5, vb).unwrap();
        // dilation=5, kernel_size=3 -> padding = 5 * (3 - 1) = 10
        assert_eq!(conv.causal_padding, 10);
    }

    #[test]
    fn test_causal_conv_forward_shape() {
        let device = Device::Cpu;
        let vb = create_mock_vb(&device);
        let conv = CausalConv1d::new(4, 8, 3, 1, vb).unwrap();

        // Input: [batch=1, channels=4, seq=10]
        let input = Tensor::randn(0.0f32, 1.0, (1, 4, 10), &device).unwrap();
        let output = conv.forward(&input).unwrap();

        // Output should preserve sequence length due to causal padding
        assert_eq!(output.dims(), &[1, 8, 10]);
    }

    #[test]
    fn test_causal_conv_preserves_length() {
        // Test that causal convolution preserves sequence length for various configs
        let device = Device::Cpu;

        for (kernel_size, dilation) in [(3, 1), (5, 1), (3, 2), (7, 3)] {
            let vb = create_mock_vb(&device);
            let conv = CausalConv1d::new(4, 8, kernel_size, dilation, vb).unwrap();

            let input = Tensor::randn(0.0f32, 1.0, (2, 4, 15), &device).unwrap();
            let output = conv.forward(&input).unwrap();

            assert_eq!(
                output.dims(),
                &[2, 8, 15],
                "Failed for kernel_size={}, dilation={}",
                kernel_size,
                dilation
            );
        }
    }

    #[test]
    fn test_causal_conv_from_weights() {
        let device = Device::Cpu;

        // Create random weights: [out_channels, in_channels, kernel_size]
        let weight = Tensor::randn(0.0f32, 1.0, (8, 4, 3), &device).unwrap();
        let bias = Tensor::randn(0.0f32, 1.0, (8,), &device).unwrap();

        let conv = CausalConv1d::from_weights(weight, Some(bias), 1).unwrap();

        let input = Tensor::randn(0.0f32, 1.0, (1, 4, 10), &device).unwrap();
        let output = conv.forward(&input).unwrap();

        assert_eq!(output.dims(), &[1, 8, 10]);
    }

    fn max_abs_diff(a: &Tensor, b: &Tensor) -> f32 {
        (a - b)
            .unwrap()
            .abs()
            .unwrap()
            .flatten_all()
            .unwrap()
            .max(0)
            .unwrap()
            .to_scalar()
            .unwrap()
    }

    #[test]
    fn test_causal_conv_streaming_matches_full() {
        let device = Device::Cpu;
        let weight = Tensor::randn(0.0f32, 1.0, (6, 4, 7), &device).unwrap();
        let bias = Tensor::randn(0.0f32, 1.0, (6,), &device).unwrap();
        let conv = CausalConv1d::from_weights(weight, Some(bias), 3).unwrap();

        let input = Tensor::randn(0.0f32, 1.0, (1, 4, 23), &device).unwrap();
        let full = conv.forward(&input).unwrap();

        let mut state = None;
        let chunks: Vec<Tensor> = [(0, 5), (5, 1), (6, 17)]
            .iter()
            .map(|&(start, len)| {
                conv.forward_with_state(&input.narrow(2, start, len).unwrap(), &mut state)
                    .unwrap()
            })
            .collect();
        let streamed = Tensor::cat(&chunks, 2).unwrap();
        assert!(max_abs_diff(&full, &streamed) < 1e-4);
    }

    #[test]
    fn test_dilated_conv_matches_conv1d() {
        let device = Device::Cpu;
        let weight = Tensor::randn(0.0f32, 1.0, (6, 4, 7), &device).unwrap();
        let bias = Tensor::randn(0.0f32, 1.0, (6,), &device).unwrap();
        let conv = CausalConv1d::from_weights(weight.clone(), Some(bias.clone()), 3).unwrap();

        let input = Tensor::randn(0.0f32, 1.0, (1, 4, 30), &device).unwrap();
        let reference = Conv1d::new(
            weight,
            Some(bias),
            Conv1dConfig {
                dilation: 3,
                ..Default::default()
            },
        )
        .forward(&input.pad_with_zeros(2, 18, 0).unwrap())
        .unwrap();
        assert!(max_abs_diff(&conv.forward(&input).unwrap(), &reference) < 1e-4);
    }

    #[test]
    fn test_pointwise_conv_matches_conv1d() {
        let device = Device::Cpu;
        let weight = Tensor::randn(0.0f32, 1.0, (6, 4, 1), &device).unwrap();
        let bias = Tensor::randn(0.0f32, 1.0, (6,), &device).unwrap();
        let conv = CausalConv1d::from_weights(weight.clone(), Some(bias.clone()), 1).unwrap();

        let input = Tensor::randn(0.0f32, 1.0, (2, 4, 9), &device).unwrap();
        let reference = Conv1d::new(weight, Some(bias), Conv1dConfig::default())
            .forward(&input)
            .unwrap();
        assert!(max_abs_diff(&conv.forward(&input).unwrap(), &reference) < 1e-4);
    }

    #[test]
    fn test_depthwise_conv_matches_grouped_conv() {
        let device = Device::Cpu;
        let dim = 8;
        let weight = Tensor::randn(0.0f32, 1.0, (dim, 1, 7), &device).unwrap();
        let bias = Tensor::randn(0.0f32, 1.0, (dim,), &device).unwrap();
        let conv =
            CausalConv1d::from_weights_grouped(weight.clone(), Some(bias.clone()), 1, dim).unwrap();

        let input = Tensor::randn(0.0f32, 1.0, (1, dim, 12), &device).unwrap();
        let reference = Conv1d::new(
            weight,
            Some(bias),
            Conv1dConfig {
                groups: dim,
                ..Default::default()
            },
        )
        .forward(&input.pad_with_zeros(2, 6, 0).unwrap())
        .unwrap();
        assert!(max_abs_diff(&conv.forward(&input).unwrap(), &reference) < 1e-4);
    }

    #[test]
    fn test_causal_conv_causality() {
        // Verify that output at position t doesn't depend on input at position t+1
        // We do this by checking that modifying future input doesn't change past output
        let device = Device::Cpu;

        let weight = Tensor::randn(0.0f32, 1.0, (4, 4, 3), &device).unwrap();
        let bias = Tensor::zeros((4,), DType::F32, &device).unwrap();
        let conv = CausalConv1d::from_weights(weight, Some(bias), 1).unwrap();

        // Input 1: [1, 4, 5] with some values
        let input1 = Tensor::randn(0.0f32, 1.0, (1, 4, 5), &device).unwrap();
        let output1 = conv.forward(&input1).unwrap();

        // Input 2: same as input1 but with different values at the last position (index 4)
        // Shape is [batch, channels, seq] = [1, 4, 5]
        // Candle uses row-major order, so we need to modify position 4 for each channel
        // Flattened order: [c0p0, c0p1, c0p2, c0p3, c0p4, c1p0, c1p1, ...]
        let input2_data: Vec<f32> = input1.flatten_all().unwrap().to_vec1().unwrap();
        let mut input2_data_modified = input2_data.clone();
        let seq_len = 5;
        // Modify position 4 (index 4) for each channel
        for c in 0..4 {
            input2_data_modified[c * seq_len + 4] += 100.0;
        }
        let input2 = Tensor::from_vec(input2_data_modified, (1, 4, 5), &device).unwrap();
        let output2 = conv.forward(&input2).unwrap();

        // Outputs at positions 0-3 should be identical (position 4 can differ)
        let out1_first4 = output1.narrow(2, 0, 4).unwrap();
        let out2_first4 = output2.narrow(2, 0, 4).unwrap();

        let diff: f32 = (&out1_first4 - &out2_first4)
            .unwrap()
            .abs()
            .unwrap()
            .sum_all()
            .unwrap()
            .to_scalar()
            .unwrap();

        assert!(
            diff < 1e-6,
            "Causal property violated: modifying future input changed past output, diff={}",
            diff
        );
    }
}
