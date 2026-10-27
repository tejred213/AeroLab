"""Fundamental force and power relations (mirror of lib/physics/forces.ts)."""

from __future__ import annotations

import math

from physics.model import DEG_TO_RAD, GRAVITY


def dynamic_pressure(density: float, speed: float) -> float:
    """q = 1/2 rho V^2  [Pa]"""
    return 0.5 * density * speed * speed


def drag_force(density: float, speed: float, cd: float, area: float) -> float:
    """Fd = 1/2 rho V^2 Cd A  [N]"""
    return dynamic_pressure(density, speed) * cd * area


def lift_force(density: float, speed: float, cl: float, area: float) -> float:
    """Fl = 1/2 rho V^2 Cl A  [N]. Positive = upward; negative Cl means downforce."""
    return dynamic_pressure(density, speed) * cl * area


def coefficient_force(q: float, coefficient: float, area: float) -> float:
    """F = q C A  [N]"""
    return q * coefficient * area


def rolling_resistance(crr: float, mass: float, gravity: float = GRAVITY) -> float:
    """Frr = Crr m g  [N] — level road, no aerodynamic load."""
    return crr * mass * gravity


def rolling_resistance_from_load(crr: float, normal_load: float) -> float:
    """Frr = Crr N; reduces to Crr m g when N = m g."""
    return crr * max(normal_load, 0.0)


def normal_load(mass: float, gradient_deg: float, lift: float, gravity: float = GRAVITY) -> float:
    """N = m g cos(theta) - Fl"""
    return max(mass * gravity * math.cos(gradient_deg * DEG_TO_RAD) - lift, 0.0)


def grade_force(mass: float, gradient_deg: float, gravity: float = GRAVITY) -> float:
    """Fgrade = m g sin(theta)  [N]. Positive theta = uphill."""
    return mass * gravity * math.sin(gradient_deg * DEG_TO_RAD)


def power(force: float, speed: float) -> float:
    """P = F V  [W]"""
    return force * speed
