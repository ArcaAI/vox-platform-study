from abc import ABC, abstractmethod
from pathlib import Path
from symspellpy import SymSpell, Verbosity
from typing import Dict, List, Optional, Tuple
from pydantic import BaseModel, Field
import re

from nlp.core.logging import get_logger
from nlp.schemas.correction import TextCorrectionResponse, SupportedLanguage, TextCorrectionRequest
from nlp.core.config import TextCorrectorConfig

logger = get_logger(__name__)


class TextCorrector(ABC):
    """Abstract class for spelling corrector"""

    def __init__(self):
        self.is_initialized = False

    @abstractmethod
    async def initialize(self) -> None:
        pass

    @abstractmethod
    async def correct(self, request: TextCorrectionRequest) -> TextCorrectionResponse:
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        pass


class SymSpellCorrector(TextCorrector):
    """SymSpell-based corrector for English and Malayalam"""

    def __init__(self, config: Optional[TextCorrectorConfig] = None):
        if config is None:
            config = TextCorrectorConfig()

        super().__init__()

        self.config = config
        self.sym_spell_instances: Dict[SupportedLanguage, SymSpell] = {}

    async def initialize(self) -> None:
        """Load SymSpell instances and dictionaries for both languages"""
        try:
            logger.info(f"Initializing text corrector service.")

            # English
            language = SupportedLanguage.ENGLISH
            self.sym_spell_instances[language] = SymSpell(
                max_dictionary_edit_distance=self.config.symspell_max_edit_distance,
                prefix_length=self.config.symspell_prefix_length,
            )
            self.sym_spell_instances[language].load_bigram_dictionary(
                self.config.dictionary_path + "/en/bigram.txt", term_index=0, count_index=1
            )
            self.sym_spell_instances[language].load_dictionary(
                self.config.dictionary_path + "/en/unigram.txt", term_index=0, count_index=1
            )

            # Malayalam
            language = SupportedLanguage.MALAYALAM
            self.sym_spell_instances[language] = SymSpell(max_dictionary_edit_distance=self.config.symspell_max_edit_distance)
            self.sym_spell_instances[language].load_bigram_dictionary(
                self.config.dictionary_path + "/ml/bigram.txt", term_index=0, count_index=1
            )
            self.sym_spell_instances[language].load_dictionary(
                self.config.dictionary_path + "/ml/unigram.txt", term_index=0, count_index=1
            )

            self.is_initialized = True

            logger.info("Text corrector initialized successfully")

        except Exception as e:
            logger.error(f"Error initializing terminology corrector: {str(e)}")

    async def correct(self, request: TextCorrectionRequest) -> TextCorrectionResponse:
        """Correct text using SymSpell"""

        if not self.is_initialized:
            await self.initialize()

        try:
            text = request.text
            language = request.language

            if language not in self.sym_spell_instances:
                raise ValueError(f"Unsupported language: {language}")

            sym_spell = self.sym_spell_instances[language]

            if len(text.split()) > 1:
                suggestions = sym_spell.lookup_compound(
                    text,
                    max_edit_distance=self.config.symspell_max_edit_distance,
                    transfer_casing=self.config.symspell_preserve_case,
                    ignore_non_words=self.config.symspell_ignore_non_words,
                    ignore_term_with_digits=self.config.symspell_ignore_term_with_digits,
                )
            else:
                suggestions = sym_spell.lookup(
                    text, verbosity=Verbosity.TOP, max_edit_distance=self.config.symspell_max_edit_distance
                )

            return TextCorrectionResponse(
                original_text=text,
                corrected_text=suggestions[0].term if suggestions else text,
                alternatives=[suggestion.term for suggestion in suggestions[1:]],
                language=language,
            )

        except Exception as e:
            logger.error(f"Error in spelling correction: {str(e)}")
            return TextCorrectionResponse(
                original_text=text,
                corrected_text=text,
                alternatives=[],
                language=language,
            )

    async def shutdown(self) -> None:
        """Shutdown the spelling corrector and clean up resources"""
        try:
            logger.info("Shutting down SymSpell corrector...")

            # Clear dictionaries and instances
            self.sym_spell_instances.clear()
            self.language_configs.clear()

            self.is_initialized = False
            logger.info("SymSpell corrector shutdown complete")

        except Exception as e:
            logger.error(f"Error during SymSpell corrector shutdown: {str(e)}")
