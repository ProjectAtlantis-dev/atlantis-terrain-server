"""Colored logging for the terrain server.

Ported from atlantis-mcp-server ColoredFormatter.
"""

import logging

# ANSI escape codes
GREY = "\x1b[90m"
YELLOW = "\x1b[33m"
ORANGE = "\x1b[38;5;214m"
RED = "\x1b[31m"
BOLD_RED = "\x1b[31;1m"
RESET = "\x1b[0m"
GREEN = "\x1b[32m"
BOLD = "\x1b[1m"
CYAN = "\x1b[36m"
BRIGHT_WHITE = "\x1b[97m"
PINK = "\x1b[95m"
MAGENTA = "\x1b[35m"
CORAL_PINK = "\x1b[38;5;204m"
SPRING_GREEN = "\x1b[38;2;0;250;154m"


class ColoredFormatter(logging.Formatter):
    FORMATS = {
        logging.DEBUG: GREY + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET,
        logging.INFO: GREEN + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET,
        logging.WARNING: YELLOW + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET,
        logging.ERROR: RED + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET,
        logging.CRITICAL: BOLD_RED + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET,
    }

    def format(self, record):
        message = record.getMessage()
        # Vehicle and assets categories should always stand out in amber.
        if (
            record.name in ("terrain.vehicle", "terrain.assets")
            or "[VEHICLE" in message
            or "[ASSETS" in message
        ):
            log_fmt = ORANGE + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET
        # DB messages in cyan
        elif record.name == "terrain.db" and record.levelno == logging.INFO:
            log_fmt = CYAN + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET
        # Texture fetch messages in magenta
        elif record.name == "terrain.tex" and record.levelno == logging.INFO:
            log_fmt = MAGENTA + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET
        # COG fetch messages in coral
        elif record.name == "terrain.cog" and record.levelno == logging.INFO:
            log_fmt = CORAL_PINK + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET
        # Traversal messages in grey (debug-level spam)
        elif record.name == "terrain.trav":
            log_fmt = GREY + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET
        # Base terrain stream in spring green for easier separation from vehicle.
        elif record.name == "terrain" and record.levelno == logging.INFO:
            log_fmt = SPRING_GREEN + "%(asctime)s [%(levelname)s] %(name)s: %(message)s" + RESET
        else:
            log_fmt = self.FORMATS.get(record.levelno, logging.BASIC_FORMAT)
        formatter = logging.Formatter(log_fmt, datefmt='%Y-%m-%d %H:%M:%S')
        return formatter.format(record)


def get_logger(name="terrain"):
    """Get a colored logger. Sub-loggers: terrain.db, terrain.tex, terrain.cog, terrain.trav"""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(ColoredFormatter())
        logger.addHandler(handler)
        logger.setLevel(
            logging.INFO
            if name in ("terrain.trav", "terrain", "terrain.tex", "terrain.cog", "terrain.vehicle", "terrain.assets")
            else logging.DEBUG
        )
        logger.propagate = False
    return logger
