#!/bin/sh
set -eu
umask 077
mkdir -p /var/data
chown node:node /var/data
exec gosu node "$@"
