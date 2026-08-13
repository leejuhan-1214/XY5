"""PyTorch reference implementation for Urban Heat Potential Lab.

The browser UI runs a dependency-free JavaScript implementation. This module
shows how the same information matrix and CA update can be vectorized with
PyTorch for larger experiments and GPU acceleration.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
import torch.nn.functional as functional


@dataclass(frozen=True)
class Weather:
    air_temperature_c: float = 34.0
    solar_w_m2: float = 850.0
    moisture: float = 0.60
    wind_u: float = 1.0
    wind_v: float = 0.0


def effective_potential(
    temperature: torch.Tensor,
    solar_absorptance: torch.Tensor,
    heat_storage: torch.Tensor,
    building_stagnation: torch.Tensor,
    green_fraction: torch.Tensor,
    evap_fraction: torch.Tensor,
) -> torch.Tensor:
    """Return dimensionless screening potential Φ for [batch, 1, y, x]."""
    return (
        temperature
        + 4.2 * heat_storage
        + 5.0 * building_stagnation
        + 5.8 * solar_absorptance
        - 5.2 * green_fraction
        - 4.5 * evap_fraction
    )


def flux(potential: torch.Tensor, wind: torch.Tensor, diffusion: float = 0.28, advection: float = 1.10) -> torch.Tensor:
    """Compute J = -D grad(Φ) + λv as [batch, 2, y, x]."""
    kernel_x = potential.new_tensor([[-0.5, 0.0, 0.5]]).view(1, 1, 1, 3)
    kernel_y = potential.new_tensor([[-0.5], [0.0], [0.5]]).view(1, 1, 3, 1)
    padded = functional.pad(potential, (1, 1, 1, 1), mode="replicate")
    grad_x = functional.conv2d(padded[:, :, 1:-1, :], kernel_x)
    grad_y = functional.conv2d(padded[:, :, :, 1:-1], kernel_y)
    return torch.cat((-diffusion * grad_x, -diffusion * grad_y), dim=1) + advection * wind


def ca_step(energy: torch.Tensor, heat_flux: torch.Tensor, source: torch.Tensor, sink: torch.Tensor, dt: float = 1.0) -> torch.Tensor:
    """Conservative finite-difference/CA-like energy update."""
    jx, jy = heat_flux[:, 0:1], heat_flux[:, 1:2]
    div_x = functional.pad(jx[:, :, :, 1:] - jx[:, :, :, :-1], (1, 0, 0, 0))
    div_y = functional.pad(jy[:, :, 1:, :] - jy[:, :, :-1, :], (0, 0, 1, 0))
    return energy + dt * (-div_x - div_y + source - sink)


def demo(device: str = "cpu") -> tuple[torch.Tensor, torch.Tensor]:
    """Create a deterministic 24x18 example and return potential and flux."""
    torch.manual_seed(8132026)
    shape = (1, 1, 18, 24)
    temperature = 31 + 16 * torch.rand(shape, device=device)
    absorptance = 0.45 + 0.5 * torch.rand(shape, device=device)
    storage = 0.2 + 0.8 * torch.rand(shape, device=device)
    buildings = torch.zeros(shape, device=device)
    buildings[:, :, 2::6, 2::6] = 0.9
    green = torch.zeros(shape, device=device)
    green[:, :, 7:11, 9:15] = 1.0
    evap = 0.6 * green
    phi = effective_potential(temperature, absorptance, storage, buildings, green, evap)
    wind = torch.zeros((1, 2, 18, 24), device=device)
    wind[:, 0] = 1.0
    return phi, flux(phi, wind)


if __name__ == "__main__":
    potential, heat_flux = demo()
    print({"potential_shape": tuple(potential.shape), "flux_shape": tuple(heat_flux.shape), "finite": bool(torch.isfinite(heat_flux).all())})
