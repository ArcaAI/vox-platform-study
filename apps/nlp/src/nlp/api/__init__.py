from fastapi import APIRouter

from nlp.api.v1 import rest_api_router_v1, ws_api_router_v1

api_router = APIRouter()

api_router.include_router(rest_api_router_v1)
api_router.include_router(ws_api_router_v1)
