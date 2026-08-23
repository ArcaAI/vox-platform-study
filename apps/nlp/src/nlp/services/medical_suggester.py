import logging
import re
from typing import Any

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline

from nlp.core.config import MedicalSuggesterConfig
from nlp.core.metrics import MODEL_SYMPTOMS_DISEASE, track_model_inference
from nlp.schemas.classification import TokenClassificationRequest
from nlp.schemas.common import Entity
from nlp.schemas.diagnosis import (
    DiagnosisSuggestion,
    DiagnosisSuggestionRequest,
    DiagnosisSuggestionResponse,
)
from nlp.services.token_classifier import TokenClassifier

logger = logging.getLogger(__name__)


class MedicalSuggester:
    def __init__(
        self,
        config: MedicalSuggesterConfig,
        token_classifier: TokenClassifier,
    ):
        # Both REQUIRED: this service runs TWO models — the disease classifier
        # named by `config` and the NER named by `token_classifier` — and both
        # selections are resolved by the caller. Neither has a default.
        self.config = config
        self.token_classifier = token_classifier
        self.is_initialized = False
        self.text_classifier_pipeline: Any = None

    async def initialize(self) -> None:
        try:
            logger.info("Initializing MedicalSuggester service")

            tokenizer = AutoTokenizer.from_pretrained(self.config.tokenizer_name)
            model = AutoModelForSequenceClassification.from_pretrained(self.config.model_name)

            self.text_classifier_pipeline = pipeline(
                "text-classification",
                model=model,
                tokenizer=tokenizer,
                # D6: config.use_gpu (default True) now gates GPU use;
                # default preserves today's auto-detect-when-available behavior.
                device=0 if (self.config.use_gpu and torch.cuda.is_available()) else -1,
            )

            # Initialize token classifier for entity extraction
            if self.token_classifier:
                await self.token_classifier.initialize()

            # self.label_mapping = model.config.id2label

            self.label_mapping = {
                "LABEL_0": "Vertigo (Paroxysmal Positional Vertigo)",
                "LABEL_1": "AIDS",
                "LABEL_2": "Acne",
                "LABEL_3": "Alcoholic hepatitis",
                "LABEL_4": "Allergy",
                "LABEL_5": "Arthritis",
                "LABEL_6": "Bronchial Asthma",
                "LABEL_7": "Cervical spondylosis",
                "LABEL_8": "Chicken pox",
                "LABEL_9": "Chronic cholestasis",
                "LABEL_10": "Common Cold",
                "LABEL_11": "Dengue",
                "LABEL_12": "Diabetes",
                "LABEL_13": "Dimorphic hemorrhoids (piles)",
                "LABEL_14": "Drug Reaction",
                "LABEL_15": "Fungal infection",
                "LABEL_16": "GERD",
                "LABEL_17": "Gastroenteritis",
                "LABEL_18": "Heart attack",
                "LABEL_19": "Hepatitis B",
                "LABEL_20": "Hepatitis C",
                "LABEL_21": "Hepatitis D",
                "LABEL_22": "Hepatitis E",
                "LABEL_23": "Hypertension",
                "LABEL_24": "Hyperthyroidism",
                "LABEL_25": "Hypoglycemia",
                "LABEL_26": "Hypothyroidism",
                "LABEL_27": "Impetigo",
                "LABEL_28": "Jaundice",
                "LABEL_29": "Malaria",
                "LABEL_30": "Migraine",
                "LABEL_31": "Osteoarthritis",
                "LABEL_32": "Paralysis (brain hemorrhage)",
                "LABEL_33": "Peptic ulcer disease",
                "LABEL_34": "Pneumonia",
                "LABEL_35": "Psoriasis",
                "LABEL_36": "Tuberculosis",
                "LABEL_37": "Typhoid",
                "LABEL_38": "Urinary tract infection",
                "LABEL_39": "Varicose veins",
                "LABEL_40": "Hepatitis A",
            }

            self.is_initialized = True

            logger.info("MedicalSuggester service initialized successfully")

        except Exception as e:
            logger.error(f"Failed to initialize MedicalSuggester: {str(e)}")
            raise

    async def suggest(self, request: DiagnosisSuggestionRequest) -> DiagnosisSuggestionResponse:
        try:
            if not self.is_initialized:
                raise RuntimeError("MedicalSuggester not initialized")

            if self.token_classifier is None:
                raise RuntimeError("TokenClassifier not configured")

            min_confidence = request.min_confidence or 0.1

            # Step 1: Extract medical entities using token classification
            token_classification_result = await self.token_classifier.process(
                request=TokenClassificationRequest(text=request.text, language=request.language)
            )

            # Filter entities based on confidence and relevance for disease prediction
            relevant_entities = self._filter_relevant_entities(
                token_classification_result.entities, min_confidence
            )

            # Step 2: Create symptom text from entities for disease prediction
            symptom_text = self._create_symptom_text(relevant_entities)

            # Step 3: Use HuggingFace model to predict diseases
            disease_predictions = await self._predict_diseases(symptom_text)

            # Step 4: Create medical suggestions from predictions
            suggestions = self._create_medical_suggestions(disease_predictions, min_confidence)

            # Create structured response
            response = DiagnosisSuggestionResponse(
                suggestions=suggestions,
                model_version=self.config.model_version,
                symptoms_analyzed=[entity.text for entity in relevant_entities],
            )

            logger.info(f"Generated {len(suggestions)} medical suggestions")
            return response

        except Exception as e:
            logger.error(f"Failed to generate medical suggestions: {str(e)}")
            raise

    def _filter_relevant_entities(
        self, entities: list[Entity], min_confidence: float
    ) -> list[Entity]:
        """Filter entities that are relevant for disease prediction"""
        relevant_entity_types = {
            "B-SIGN_SYMPTOM",
            "I-SIGN_SYMPTOM",
            "B-DISEASE_DISORDER",
            "I-DISEASE_DISORDER",
            "B-BIOLOGICAL_STRUCTURE",
            "I-BIOLOGICAL_STRUCTURE",
            "B-CLINICAL_EVENT",
            "I-CLINICAL_EVENT",
            "B-SEVERITY",
            "I-SEVERITY",
            "B-DURATION",
            "I-DURATION",
            "B-FREQUENCY",
            "I-FREQUENCY",
            "B-QUALITATIVE_CONCEPT",
            "I-QUALITATIVE_CONCEPT",
        }

        filtered_entities = []
        for entity in entities:
            if (
                entity.entity_type in relevant_entity_types
                and entity.confidence >= min_confidence
                and len(entity.text.strip()) > 2
            ):  # Filter out very short entities
                filtered_entities.append(entity)

        return filtered_entities

    def _create_symptom_text(self, entities: list[Entity]) -> str:
        """Create a coherent symptom description from extracted entities"""
        if not entities:
            return ""

        # Group entities by type for better text construction
        entity_groups: dict[str, list[str]] = {}
        for entity in entities:
            entity_type = entity.entity_type.replace("B-", "").replace("I-", "")
            if entity_type not in entity_groups:
                entity_groups[entity_type] = []
            entity_groups[entity_type].append(entity.text)

        # Create symptom text prioritizing symptoms and signs
        symptom_parts = []

        # Add symptoms and signs first
        if "SIGN_SYMPTOM" in entity_groups:
            symptom_parts.extend(entity_groups["SIGN_SYMPTOM"])

        # Add severity and duration context
        if "SEVERITY" in entity_groups:
            symptom_parts.extend(entity_groups["SEVERITY"])

        if "DURATION" in entity_groups:
            symptom_parts.extend(entity_groups["DURATION"])

        # Add other relevant entities
        for entity_type, entity_texts in entity_groups.items():
            if entity_type not in ["SIGN_SYMPTOM", "SEVERITY", "DURATION"]:
                symptom_parts.extend(entity_texts)

        # Create coherent text
        symptom_text = ", ".join(set(symptom_parts)).replace("▁", "")
        return symptom_text.strip()

    async def _predict_diseases(self, symptom_text: str) -> dict[str, float]:
        """Use HuggingFace model to predict diseases from symptoms"""
        if not symptom_text:
            return {}

        try:
            # Per-model running gauge + inference latency
            # (symps-disease-bert).
            with track_model_inference(MODEL_SYMPTOMS_DISEASE):
                pipeline_results = self.text_classifier_pipeline(symptom_text)

            pipeline_results.sort(key=lambda x: x["score"], reverse=True)

            probabilities = {}
            for score_item in pipeline_results:
                readable_label = self._to_readable_label(score_item["label"])
                probabilities[readable_label] = float(score_item["score"])

            return probabilities

        except Exception as e:
            logger.error(f"Error in disease prediction: {str(e)}")
            return {}

    def _to_readable_label(self, model_label: str) -> str:
        """Convert model label to readable disease name"""
        normalized_label = model_label.upper()

        if normalized_label in self.label_mapping:
            return self.label_mapping[normalized_label]

        label_match = re.search(r"(\d+)", model_label)
        if label_match:
            label_num = int(label_match.group(1))
            label_key = f"LABEL_{label_num}"
            if label_key in self.label_mapping:
                return self.label_mapping[label_key]

        return model_label

    def _create_medical_suggestions(
        self, disease_predictions: dict[str, float], min_confidence: float
    ) -> list[DiagnosisSuggestion]:
        """Create medical suggestions from disease predictions and entities"""
        suggestions = []

        for disease, confidence in disease_predictions.items():
            if confidence >= min_confidence:
                suggestions.append(
                    DiagnosisSuggestion(
                        disease=disease,
                        confidence=confidence,
                    )
                )

        return suggestions

    async def shutdown(self) -> None:
        if self.is_initialized:
            if self.token_classifier and hasattr(self.token_classifier, "shutdown"):
                await self.token_classifier.shutdown()
            self.is_initialized = False
