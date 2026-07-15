#!/bin/bash
source .env
psql "$DATABASE_URL"
