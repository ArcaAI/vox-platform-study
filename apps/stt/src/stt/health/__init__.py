"""Health check module."""

from .api.routes import internal_router, router

__all__ = ["router", "internal_router"]
