# Vector Volley — developer tasks (no npm dependencies)

GAME_FILES := index.html style.css game.js
SITE_ASSETS := preview.png
SITE_DIR := site
PORT ?= 8000

.DEFAULT_GOAL := help

.PHONY: help serve check size test verify site clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

serve: ## Serve the game at http://localhost:$(PORT)
	python3 -m http.server $(PORT)

check: ## Syntax-check game.js
	node --check game.js

size: ## Report combined size of the three game files
	@wc -c $(GAME_FILES)
	@total=$$(cat $(GAME_FILES) | wc -c); \
		echo "Combined: $$total bytes / 51200 budget"; \
		if [ "$$total" -ge 51200 ]; then echo "Over the 50 KB budget"; exit 1; fi

test: ## Run the dependency-free black-box test suite
	node tests/run.mjs

verify: check size test ## Run syntax, size budget, and tests

site: ## Stage the game files and preview image into site/ for static hosting
	mkdir -p $(SITE_DIR)
	cp $(GAME_FILES) $(SITE_ASSETS) $(SITE_DIR)/

clean: ## Remove local artifacts
	rm -rf $(SITE_DIR) tests/.chrome-user-data *.log *.tmp
