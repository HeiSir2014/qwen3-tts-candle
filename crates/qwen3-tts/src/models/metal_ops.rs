//! Custom fused Metal kernels for ops candle runs as several elementwise
//! passes. Each op is a candle `CustomOp` with a Metal implementation only;
//! callers keep their tensor-op path for other devices.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use candle_core::backend::BackendStorage;
use candle_core::metal_backend::{buffer_o, DeviceId};
use candle_core::{CpuStorage, CustomOp3, DType, Layout, MetalDevice, MetalStorage, Result, Shape};
use candle_metal_kernels::metal::ComputePipeline;
use candle_metal_kernels::utils::get_block_dims;
use candle_metal_kernels::{set_params, Output};

const SOURCE: &str = r#"
#include <metal_stdlib>
using namespace metal;

// y = x + inv_beta[c] * sin(alpha[c] * x)^2 over contiguous [batch, channels, len]
kernel void snake_beta_f32(
    constant size_t &numel [[buffer(0)]],
    constant size_t &channels [[buffer(1)]],
    constant size_t &len [[buffer(2)]],
    device const float *x [[buffer(3)]],
    device const float *alpha [[buffer(4)]],
    device const float *inv_beta [[buffer(5)]],
    device float *y [[buffer(6)]],
    uint i [[thread_position_in_grid]])
{
    if (i >= numel) {
        return;
    }
    size_t c = (i / len) % channels;
    float v = x[i];
    float s = precise::sin(alpha[c] * v);
    y[i] = v + inv_beta[c] * s * s;
}
"#;

/// Compile [`SOURCE`] once per device and return the named pipeline.
fn pipeline(device: &MetalDevice, name: &'static str) -> Result<ComputePipeline> {
    static CACHE: OnceLock<Mutex<HashMap<(DeviceId, &'static str), ComputePipeline>>> =
        OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| candle_core::Error::Msg(e.to_string()))?;
    if let Some(pipeline) = cache.get(&(device.id(), name)) {
        return Ok(pipeline.clone());
    }
    let metal = device.metal_device();
    let library = metal
        .new_library_with_source(SOURCE, None)
        .map_err(candle_core::Error::wrap)?;
    let function = library
        .get_function(name, None)
        .map_err(candle_core::Error::wrap)?;
    let pipeline = metal
        .new_compute_pipeline_state_with_function(&function)
        .map_err(candle_core::Error::wrap)?;
    cache.insert((device.id(), name), pipeline.clone());
    Ok(pipeline)
}

/// Fused SnakeBeta: `x + inv_beta * sin²(alpha * x)` with per-channel
/// `alpha = exp(alpha_param)` and `inv_beta = 1 / (exp(beta_param) + eps)`.
pub struct SnakeBetaOp;

impl CustomOp3 for SnakeBetaOp {
    fn name(&self) -> &'static str {
        "snake-beta"
    }

    fn cpu_fwd(
        &self,
        _: &CpuStorage,
        _: &Layout,
        _: &CpuStorage,
        _: &Layout,
        _: &CpuStorage,
        _: &Layout,
    ) -> Result<(CpuStorage, Shape)> {
        candle_core::bail!("snake-beta custom op is Metal-only")
    }

    fn metal_fwd(
        &self,
        x: &MetalStorage,
        x_l: &Layout,
        alpha: &MetalStorage,
        alpha_l: &Layout,
        inv_beta: &MetalStorage,
        inv_beta_l: &Layout,
    ) -> Result<(MetalStorage, Shape)> {
        let dtypes = [x.dtype(), alpha.dtype(), inv_beta.dtype()];
        if dtypes.iter().any(|&dt| dt != DType::F32) {
            candle_core::bail!("snake-beta expects f32 inputs, got {dtypes:?}");
        }
        if !x_l.is_contiguous() || !alpha_l.is_contiguous() || !inv_beta_l.is_contiguous() {
            candle_core::bail!("snake-beta expects contiguous inputs");
        }
        let (_batch, channels, len) = x_l.shape().dims3()?;
        if alpha_l.shape().elem_count() != channels || inv_beta_l.shape().elem_count() != channels {
            candle_core::bail!("snake-beta expects [{channels}] alpha/inv_beta");
        }
        let numel = x_l.shape().elem_count();

        let device = x.device();
        let pipeline = pipeline(device, "snake_beta_f32")?;
        let output = device
            .new_buffer_builder()
            .with_size_for(numel, DType::F32)
            .with_label("snake-beta")
            .build()?;

        let encoder = device.command_encoder()?;
        let encoder = encoder.as_ref();
        encoder.set_compute_pipeline_state(&pipeline);
        let x_b = buffer_o(x.buffer(), x_l, DType::F32);
        let alpha_b = buffer_o(alpha.buffer(), alpha_l, DType::F32);
        let inv_beta_b = buffer_o(inv_beta.buffer(), inv_beta_l, DType::F32);
        set_params!(
            encoder,
            (
                numel,
                channels,
                len,
                &x_b,
                &alpha_b,
                &inv_beta_b,
                Output::new(&output)
            )
        );
        // MTLSize is not re-exported by candle; get_block_dims hands one out.
        let width = pipeline.max_total_threads_per_threadgroup().min(numel);
        let mut group_size = get_block_dims(1, 1, 1);
        group_size.width = width;
        group_size.height = 1;
        group_size.depth = 1;
        let mut group_count = group_size;
        group_count.width = numel.div_ceil(width);
        encoder.dispatch_thread_groups(group_count, group_size);

        Ok((
            MetalStorage::new(output, device.clone(), numel, DType::F32),
            x_l.shape().clone(),
        ))
    }
}
