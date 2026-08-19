from fastapi import APIRouter

from .rest.classify import router as classify_router
from .rest.correct import router as correct_router
from .rest.diagnosis import router as diagnosis_router
from .rest.extract import router as extract_router
from .rest.guard import router as guard_router
from .rest.monitoring import router as monitoring_router
from .ws.classify import router as ws_classify_router

# REST
rest_api_router_v1 = APIRouter(prefix="/api/v1")

rest_api_router_v1.include_router(classify_router)
rest_api_router_v1.include_router(correct_router)
rest_api_router_v1.include_router(diagnosis_router)
rest_api_router_v1.include_router(extract_router)
rest_api_router_v1.include_router(guard_router)
rest_api_router_v1.include_router(monitoring_router)

# WS
ws_api_router_v1 = APIRouter(prefix="/ws")

ws_api_router_v1.include_router(ws_classify_router)
