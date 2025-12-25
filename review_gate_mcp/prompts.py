"""
MCP Prompts implementation for Review Gate V3.
Provides pre-built prompt templates for common review scenarios.
"""
import json
import re
import time
from typing import Any, Dict, List, Optional

from mcp.types import Prompt, PromptArgument, PromptMessage

from .config import logger
from .database import get_database


class PromptManager:
    """Manages MCP prompts for common review scenarios."""

    def __init__(self):
        self._prompts_cache: Optional[List[Prompt]] = None
        self._cache_timestamp: float = 0
        self._cache_ttl: float = 10.0  # Cache for 10 seconds

    async def list_prompts(self) -> List[Prompt]:
        """List all available MCP prompts."""
        # Check cache
        if time.time() - self._cache_timestamp < self._cache_ttl:
            return self._prompts_cache or []

        db = await get_database()
        templates = await db.list_templates()

        prompts = []
        for template in templates:
            # Convert template to MCP prompt
            arguments = []
            args_schema = template.get('arguments_schema')
            if args_schema and isinstance(args_schema, dict):
                properties = args_schema.get('properties', {})
                for prop_name, prop_def in properties.items():
                    arguments.append(PromptArgument(
                        name=prop_name,
                        description=prop_def.get('description', ''),
                        required=prop_name in args_schema.get('required', [])
                    ))

            prompts.append(Prompt(
                name=template['name'],
                description=template.get('description') or template['title'],
                arguments=arguments
            ))

        # Cache the results
        self._prompts_cache = prompts
        self._cache_timestamp = time.time()

        return prompts

    async def get_prompt(
        self,
        name: str,
        arguments: Optional[Dict[str, Any]] = None
    ) -> List[PromptMessage]:
        """Get a prompt by name with arguments substituted."""
        db = await get_database()
        template = await db.get_template(name)

        if not template:
            raise ValueError(f"Prompt not found: {name}")

        prompt_template = template['prompt_template']
        args_schema = template.get('arguments_schema')

        # Substitute arguments into template
        content = self._substitute_template(prompt_template, arguments or {})

        return [
            PromptMessage(
                role="user",
                content=PromptMessageContent(
                    type="text",
                    text=content
                )
            )
        ]

    def _substitute_template(self, template: str, arguments: Dict[str, Any]) -> str:
        """Substitute arguments into the template using simple variable replacement."""
        result = template

        # Handle {{#if var}}...{{/if}} conditionals
        def process_conditionals(text: str) -> str:
            """Process conditional blocks in template."""
            pattern = r'\{\{#if\s+(\w+)\}\}(.*?)\{\{/if\}\}'

            def replace_conditional(match):
                var_name = match.group(1)
                content = match.group(2)
                if var_name in arguments and arguments[var_name]:
                    # Remove extra whitespace from content
                    return content.strip()
                return ""

            return re.sub(pattern, replace_conditional, text, flags=re.DOTALL)

        result = process_conditionals(result)

        # Handle {{var}} simple variables
        def replace_variable(match):
            var_name = match.group(1)
            value = arguments.get(var_name, '')
            if isinstance(value, (list, dict)):
                return json.dumps(value)
            return str(value)

        result = re.sub(r'\{\{(\w+)\}\}', replace_variable, result)

        return result.strip()

    def invalidate_cache(self) -> None:
        """Invalidate the prompts cache."""
        self._cache_timestamp = 0


# Global prompt manager instance
_prompt_manager: Optional[PromptManager] = None


def get_prompt_manager() -> PromptManager:
    """Get or create the global prompt manager instance."""
    global _prompt_manager
    if _prompt_manager is None:
        _prompt_manager = PromptManager()
    return _prompt_manager


# Type alias for message content
class PromptMessageContent:
    """Content for a prompt message."""
    def __init__(self, type: str, text: str):
        self.type = type
        self.text = text
