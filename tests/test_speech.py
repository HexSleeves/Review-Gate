import importlib
import unittest
from unittest import mock

speech = importlib.import_module("review_gate_mcp.speech")


class TestSpeechHandler(unittest.TestCase):
    def test_speech_handler_boots_cleanly_when_whisper_is_unavailable(self):
        with mock.patch.object(speech, "WHISPER_AVAILABLE", False):
            handler = speech.SpeechHandler()
            status = handler.get_status()

        self.assertFalse(status["whisper_model_loaded"])
        self.assertFalse(status["faster_whisper_available"])
        self.assertIsNotNone(status["whisper_error"])
