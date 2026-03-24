import asyncio
import sys
import os
from .config import logger
from .server import ReviewGateServer

async def main():
    """Main entry point for Review Gate V3 with immediate activation"""
    logger.info("🎬 STARTING Review Gate V3 MCP Server...")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Platform: {sys.platform}")
    logger.info(f"OS name: {os.name}")
    logger.info(f"Working directory: {os.getcwd()}")

    try:
        server = ReviewGateServer()
        await server.run()
    except Exception as e:
        logger.error(f"❌ Fatal error in MCP server: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise


def cli():
    """Console-script entrypoint."""
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("🛑 Server stopped by user")
    except Exception as e:
        logger.error(f"❌ Server crashed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    cli()
