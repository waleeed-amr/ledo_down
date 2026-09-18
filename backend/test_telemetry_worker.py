"""Fast, network-free contract tests for the remote admin integration."""

import unittest

import telemetry_worker as telemetry


class TelemetryContractTests(unittest.TestCase):
    def test_versions_normalize_trailing_zeroes(self):
        self.assertEqual(telemetry._parse_version("3.9"), telemetry._parse_version("3.9.0"))
        self.assertGreater(telemetry._parse_version("4.0.0"), telemetry._parse_version("3.9.2010"))

    def test_invalid_versions_are_rejected(self):
        self.assertIsNone(telemetry._parse_version("latest"))
        self.assertIsNone(telemetry._parse_version("4..0"))

    def test_only_https_links_are_exposed(self):
        self.assertTrue(telemetry._is_safe_public_url("https://example.com/download.exe"))
        self.assertFalse(telemetry._is_safe_public_url("http://example.com/download.exe"))
        self.assertFalse(telemetry._is_safe_public_url("javascript:alert(1)"))


if __name__ == "__main__":
    unittest.main()
