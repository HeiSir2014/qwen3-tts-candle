//! Custom fused Metal kernels for ops candle runs as several elementwise
//! passes. Each op is a candle `CustomOp` with a Metal implementation only;
//! callers keep their tensor-op path for other devices.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use candle_core::backend::BackendStorage;
use candle_core::metal_backend::{buffer_o, DeviceId};
use candle_core::{
    CpuStorage, CustomOp2, CustomOp3, DType, Layout, MetalDevice, MetalStorage, Result, Shape,
};
use candle_metal_kernels::metal::{ComputeCommandEncoder, ComputePipeline};
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

// out = silu(gate) * up, elementwise over contiguous inputs
template <typename T>
void swiglu(
    constant size_t &numel,
    device const T *gate,
    device const T *up,
    device T *out,
    uint i)
{
    if (i >= numel) {
        return;
    }
    // Round silu(gate) to T like candle's separate silu and mul kernels.
    float g = float(gate[i]);
    T silu = T(g / (1.0f + exp(-g)));
    out[i] = T(float(silu) * float(up[i]));
}

#define INSTANTIATE(NAME, T) \
kernel void swiglu_##NAME( \
    constant size_t &numel [[buffer(0)]], \
    device const T *gate [[buffer(1)]], \
    device const T *up [[buffer(2)]], \
    device T *out [[buffer(3)]], \
    uint i [[thread_position_in_grid]]) \
{ \
    swiglu<T>(numel, gate, up, out, i); \
}

INSTANTIATE(f32, float)
INSTANTIATE(f16, half)
INSTANTIATE(bf16, bfloat)
"#;

/// Dispatch `groups` threadgroups of `threads` threads along x.
fn dispatch_1d(encoder: &ComputeCommandEncoder, groups: usize, threads: usize) {
    // MTLSize is not re-exported by candle; get_block_dims hands one out.
    let mut group_size = get_block_dims(1, 1, 1);
    group_size.width = threads;
    group_size.height = 1;
    group_size.depth = 1;
    let mut group_count = group_size;
    group_count.width = groups;
    encoder.dispatch_thread_groups(group_count, group_size);
}

/// Pick the `[f32, f16, bf16]` kernel name for `dtype`.
fn kernel_for(dtype: DType, names: [&'static str; 3]) -> Result<&'static str> {
    Ok(match dtype {
        DType::F32 => names[0],
        DType::F16 => names[1],
        DType::BF16 => names[2],
        dtype => candle_core::bail!("unsupported dtype {dtype:?} for fused Metal op"),
    })
}

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
        let width = pipeline.max_total_threads_per_threadgroup().min(numel);
        dispatch_1d(encoder, numel.div_ceil(width), width);

        Ok((
            MetalStorage::new(output, device.clone(), numel, DType::F32),
            x_l.shape().clone(),
        ))
    }
}

/// Fused SwiGLU gate: `silu(gate) * up`.
pub struct SwigluOp;

impl CustomOp2 for SwigluOp {
    fn name(&self) -> &'static str {
        "swiglu"
    }

    fn cpu_fwd(
        &self,
        _: &CpuStorage,
        _: &Layout,
        _: &CpuStorage,
        _: &Layout,
    ) -> Result<(CpuStorage, Shape)> {
        candle_core::bail!("swiglu custom op is Metal-only")
    }

    fn metal_fwd(
        &self,
        gate: &MetalStorage,
        gate_l: &Layout,
        up: &MetalStorage,
        up_l: &Layout,
    ) -> Result<(MetalStorage, Shape)> {
        let dtype = gate.dtype();
        if up.dtype() != dtype || gate_l.shape() != up_l.shape() {
            candle_core::bail!("swiglu expects gate and up of the same dtype and shape");
        }
        if !gate_l.is_contiguous() || !up_l.is_contiguous() {
            candle_core::bail!("swiglu expects contiguous inputs");
        }
        let numel = gate_l.shape().elem_count();
        let name = kernel_for(dtype, ["swiglu_f32", "swiglu_f16", "swiglu_bf16"])?;

        let device = gate.device();
        let pipeline = pipeline(device, name)?;
        let output = device
            .new_buffer_builder()
            .with_size_for(numel, dtype)
            .with_label("swiglu")
            .build()?;

        let encoder = device.command_encoder()?;
        let encoder = encoder.as_ref();
        encoder.set_compute_pipeline_state(&pipeline);
        let gate_b = buffer_o(gate.buffer(), gate_l, dtype);
        let up_b = buffer_o(up.buffer(), up_l, dtype);
        set_params!(encoder, (numel, &gate_b, &up_b, Output::new(&output)));
        let width = pipeline.max_total_threads_per_threadgroup().min(numel);
        dispatch_1d(encoder, numel.div_ceil(width), width);

        Ok((
            MetalStorage::new(output, device.clone(), numel, dtype),
            gate_l.shape().clone(),
        ))
    }
}
