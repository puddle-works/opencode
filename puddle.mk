# Shared make targets for puddle repos. Copy this file into the repo and put
# `include puddle.mk` in the Makefile. The targets fetch the checks and the
# publish script from the tagged puddle-tooling release named by TOOLING_REF,
# so every repo runs the same code.
#
#   make contracts-check                    workflow data reads match schemas
#   make guardrails-check                   every workflow declares its limits
#   make publish VISIBILITY=public|private  push the extension (DRY_RUN=1 to
#                                           stop after the dry run)
#
# Set PUDDLE_TOOLING_DIR to a local puddle-tooling checkout to use it instead
# of the tagged release. Set PUBLISH_TESTS to what publish runs before pushing
# (default: make test).

TOOLING_REF ?= v0.2.1
TOOLING_URL ?= https://raw.githubusercontent.com/puddle-works/puddle-tooling/$(TOOLING_REF)
DENO ?= $(shell swamp doctor extensions --json 2>/dev/null | jq -r '.denoPath')
PUBLISH_TESTS ?= $(MAKE) test

ifdef PUDDLE_TOOLING_DIR
tooling_src = $(PUDDLE_TOOLING_DIR)
tooling_script = env DENO="$(DENO)" VISIBILITY="$(VISIBILITY)" \
  DRY_RUN="$(DRY_RUN)" PUBLISH_TESTS="$(PUBLISH_TESTS)" \
  sh $(PUDDLE_TOOLING_DIR)/scripts/publish.sh
else
tooling_src = $(TOOLING_URL)
# The settings sit on `sh`, not on `curl`: a prefix before a pipeline only
# reaches its first command.
tooling_script = curl -fsSL $(TOOLING_URL)/scripts/publish.sh | env \
  DENO="$(DENO)" VISIBILITY="$(VISIBILITY)" DRY_RUN="$(DRY_RUN)" \
  PUBLISH_TESTS="$(PUBLISH_TESTS)" sh
endif

.PHONY: contracts-check guardrails-check publish

contracts-check: ## Check workflow data reads against extension schemas
	$(DENO) run --allow-read --allow-env $(tooling_src)/contracts/check.ts

guardrails-check: ## Check every workflow declares maxReruns and maxWallClock
	$(DENO) run --allow-read $(tooling_src)/guardrails/check.ts

publish: ## Publish the extension (VISIBILITY=public|private, DRY_RUN=1 to stop early)
	$(tooling_script)
