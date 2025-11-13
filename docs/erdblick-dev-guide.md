# Erdblick Development Guide

This document shall provide you with some in-depth insights regarding the inner
workings of erdblick. It is not a user guide. Please check [here](TODO-INSERT-LINK)
if you are looking for that!

We will start off with a component overview, and explain their relationships.
This will also allow us to pinpoint various complexity hotspots. These are
then explained in the following sections.

## Development Setup

The easiest way to develop erdblick is by using a UI which can handle both
C++ and Typescript/Angular. We have great experience using CLion for this
task, but other more lightweight text editors such as VSCode or Sublime
might also do great for you. For debug sources in the browser, make
sure to set `NG_DEVELOP=true` in your environment before calling the `./ci/...`
build scripts.

We noticed, that Chrome does usually deliver the best performance for erdblick.
But for both for development and usage, we are also using Firefox, Edge and occasionally Safari as well.
So use a browser of your choice but be prepared to switch to Chrome if you
notice severe performance degradation during your debug sessions.

## Component Overview

(Extend existing diagram)

(Component explanations)

## Tile Loading Sequence

(Exhaustive sequence diagram and explanation)

## Rendering

(Sequence Diagram of TileVisualization)

- Style Sheets, FeatureLayerVisualization, TileVisualization
- (Recursive) Relation Visualization
- Feature Representation (incl feature IDs)
- Merged Point Features

## Exceptions and (Missing) Error Handling

One weak point of the current architecture is error handling.
There are several types of errors, which are handled in different
ways. But you will find that most of these error types are
not yet handled in a user-friendly way. In the following, there
is an overview of different error types, and a description of
how such an error may be spotted.

### JavaScript Errors

Most UI errors that you will encounter are based on exceptions
in our Angular frontend code. In this case, ensure that you have
a development build, e.g. by setting the env `NG_DEVELOP=true`
when calling `./ci/20_linux_rebuild.bash`.

In this case, JS exceptions should be associated with a detailed
stacktrace in the frontend, and (more or less) straight-forward to debug.

### WASM Exceptions

Another common source of errors are exceptions which originate
from the `erdblick-core` WASM library. Here, it is really important
to note the following:

**We are compiling WASM without C++ exception support due to
performance reasons. C++-Native exception handling consistently
drops the browser out of JIT, which is very slow.** Due to this
reason, we currently do the following: Via `bindings.cpp`, we
install an exception handler, which

- Cesium Rendering Errors
- TileLayerStream parsing errors
- Style Sheet Parsing Errors
- Style Sheet Execution Errors
- Tiles with Errors
- Mapget Connection Loss

## Feature Search

(Sequence Diagram of SearchService <-> Worker interaction)

- WebWorker Pitfalls
    - console.log
    - (de-)serialization overhead
    - Result batch communication

## Feature and SourceDataLayer Selection

(Flow Chart Diagram of Feature/SourceDataLayer Selection)

## Debugging Strategies

When developing erdblick, there are several tools which will come in handy:
- **Browser JS Debugger**: The m
- WASM Debug Mode
- corelib test
- ebDebug
- Browser Network Debugger
- Browser Profiler
- Viewport Statistics Dialog

## Coding Conventions

Erdblick Developers have the following code style agreements:

- For C++ code, we use the style as defined in `.clang-format`.
- For JS code:
    - We use `{}` even for one-line ifs.
    - We prefer early returns over nested conditions.
    - We use `const` instead of `let` wherever possible, and avoid `var`.
    - *(Please amend this list!)*
