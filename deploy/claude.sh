#!/bin/sh
# Subscription sessions run the installed claude command on its default config dir (~/.claude: its login and settings).
exec claude "$@"
