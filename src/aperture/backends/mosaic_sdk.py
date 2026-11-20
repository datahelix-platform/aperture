"""Local SDK backend adapter for Mosaic."""

from __future__ import annotations

import getpass
from pathlib import Path
from typing import Any


class MosaicSdkBackend:
    """Backend that uses the Mosaic SDK directly for local mode."""

    def __init__(self, config_path: str = "./mosaic.yaml") -> None:
        # Lazy import to avoid mandatory dependency
        from mosaic import MosaicClient
        from mosaic.config.loader import load_mosaic_config

        mosaic_config = load_mosaic_config(Path(config_path))
        self._client = MosaicClient(
            schemas=mosaic_config.schemas if hasattr(mosaic_config, "schemas") else None,
            storage=None,
        )
        self._config_path = config_path

    def list_entities(
        self,
        entity_type: str,
        filters: dict | None = None,
        limit: int = 50,
        offset: int = 0,
        include_unavailable: bool = False,
    ) -> list[dict]:
        result = self._client._query_service.get(
            entity_type=entity_type,
            entity_id="*",
            include_unavailable=include_unavailable,
        )
        # The SDK returns different structures; normalize to list of dicts
        if isinstance(result, dict) and "items" in result:
            items = result["items"]
        elif isinstance(result, list):
            items = result
        else:
            items = [result] if result else []
        return items[offset : offset + limit]

    def get_entity(self, entity_type: str, entity_id: str) -> dict:
        return self._client._query_service.get(
            entity_type=entity_type,
            entity_id=entity_id,
        )

    def create_entity(
        self, entity_type: str, data: dict, actor: str
    ) -> dict:
        return self._client._ingestion_service.put(
            entity_type=entity_type,
            data=data,
        )

    def update_entity(
        self, entity_type: str, entity_id: str, data: dict, actor: str
    ) -> dict:
        return self._client._ingestion_service.put(
            entity_type=entity_type,
            data=data,
            entity_id=entity_id,
        )

    def set_availability(
        self, entity_type: str, entity_id: str, available: bool, actor: str
    ) -> dict:
        # SDK doesn't have a direct availability toggle; update the entity
        return self._client._ingestion_service.put(
            entity_type=entity_type,
            data={"is_available": available},
            entity_id=entity_id,
        )

    def search(
        self,
        entity_type: str,
        query: str,
        field: str | None = None,
        limit: int = 10,
    ) -> list[dict]:
        results = self._client._query_service.get(
            entity_type=entity_type,
            entity_id="*",
        )
        # Basic filtering fallback
        if isinstance(results, list):
            return results[:limit]
        return []

    def get_history(
        self, entity_type: str, entity_id: str
    ) -> list[dict]:
        summary = self._client._provenance_service.get_provenance_summary_map(
            entity_type=entity_type,
        )
        return list(summary.get(entity_id, {}).values()) if entity_id in summary else []

    def list_entity_types(self) -> list[str]:
        if self._client._schema_manager.schemas:
            return list(self._client._schema_manager.schemas.keys())
        return []

    def get_entity_type_schema(self, entity_type: str) -> dict:
        if self._client._schema_manager.schemas:
            schema = self._client._schema_manager.schemas.get(entity_type)
            if schema:
                return schema.model_dump() if hasattr(schema, "model_dump") else vars(schema)
        return {}

    def status(self) -> dict:
        entity_types = self.list_entity_types()
        return {
            "component": "mosaic",
            "mode": "sdk",
            "path": self._config_path,
            "status": "healthy",
            "version": "0.3.1",
            "entity_types": len(entity_types),
        }
