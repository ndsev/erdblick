#!/usr/bin/env bash
set -e

SOURCE_LOC=$1
BUILD_MODE=$2  # New parameter for build mode
if [ -z $SOURCE_LOC ]; then
  echo "No source location supplied."
  exit 1
fi

# Validate build mode if provided
if [ ! -z "$BUILD_MODE" ]; then
  if [[ "$BUILD_MODE" != "default" && "$BUILD_MODE" != "visualization-only" && "$BUILD_MODE" != "all" ]]; then
    echo "Invalid build mode. Supported values are: default, visualization-only, all"
    exit 1
  fi
fi

echo "Using source dir @ $SOURCE_LOC."
cd "$SOURCE_LOC" || exit 1

echo "Collecting npm modules."
npm install

echo "Building Angular distribution files."
npm run lint

# Profiling builds retain the production optimizer while preserving JavaScript
# identifiers and source maps for browser performance tools.
build_profile_configuration() {
  local base_configuration="$1"
  NG_BUILD_MANGLE=false npm run build -- -c "${base_configuration},profiling"
}

# Determine which build mode to use
if [[ "$BUILD_MODE" == "all" ]]; then
  echo "Building all configurations..."
  if [[ -n "$NG_DEVELOP" ]]; then
    npm run build -- -c development
    npm run build -- -c visualization-only-dev
  elif [[ -n "$ERDBLICK_PROFILE_BUILD" ]]; then
    build_profile_configuration production
    build_profile_configuration visualization-only
  else
    npm run build
    npm run build -- -c visualization-only
  fi
elif [[ -n "$NG_DEVELOP" && "$BUILD_MODE" == "visualization-only" ]]; then
  echo "Building in visualization-only development mode."
  npm run build -- -c visualization-only-dev
elif [[ -n "$NG_DEVELOP" ]]; then
  npm run build -- -c development
elif [[ -n "$ERDBLICK_PROFILE_BUILD" && "$BUILD_MODE" == "visualization-only" ]]; then
  build_profile_configuration visualization-only
elif [[ -n "$ERDBLICK_PROFILE_BUILD" ]]; then
  build_profile_configuration production
elif [[ "$BUILD_MODE" == "visualization-only" ]]; then
  echo "Building in visualization-only mode."
  npm run build -- -c visualization-only
else
  npm run build
fi

exit 0
