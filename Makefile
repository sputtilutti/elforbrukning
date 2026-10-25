# Elfakturor. Kör `make` för en lista över vad du kan göra.
#
# Vanligt flöde när det kommit nya fakturor:
#   1. Lägg PDF-filerna i fakturamappen (FAKTUROR nedan)
#   2. make update      (läser nya fakturor, bygger CSV och data till webbsidan, visar anmärkningar)
#   3. make serve       (öppna http://localhost:8765)

# --- Inställningar. Åsidosätt vid behov: make update FAKTUROR="/annan/mapp",
# --- eller skriv dem i en egen fil config.mk (läses automatiskt, bör inte läggas i git).
FAKTUROR  ?= ./Förbrukning
SPOT_PDF  ?= $(HOME)/Downloads/manadspriser-pa-elborsen-mellan-1996-och-2025.pdf
SPOT_YEAR ?= 2026
PORT      ?= 8765
WORKDIR   ?= tmp
VENV      ?= .venv

-include config.mk

PYTHON := $(VENV)/bin/python
export WORKDIR

.DEFAULT_GOAL := help
.NOTPARALLEL:
.PHONY: help setup update full parse finalize summarize export granska serve start spot demo test

help:  ## Visar den här listan
	@echo "Elfakturor"
	@echo
	@echo "Vanligt flöde när det kommit nya fakturor:"
	@echo "  1. Lägg PDF-filerna i fakturamappen:"
	@echo "       $(FAKTUROR)"
	@echo "  2. make update    läser nya fakturor, bygger CSV och webbdata, visar anmärkningar"
	@echo "  3. make serve     startar webbsidan på http://localhost:$(PORT)"
	@echo
	@echo "Alla kommandon:"
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'
	@echo
	@echo "Inställningar kan åsidosättas, t.ex.: make update FAKTUROR=\"/annan/mapp\" (eller i config.mk)"

$(VENV)/.installed: requirements.txt
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r requirements.txt
	touch $(VENV)/.installed

setup: $(VENV)/.installed  ## Skapar virtualenv och installerar beroenden (görs automatiskt vid behov)

update: parse finalize summarize export granska  ## Hela flödet: läs nya fakturor, bygg CSV och webbdata, visa anmärkningar

full: ## Som update, men tolkar om alla PDF:er (om du misstänker att något blivit fel)
	@$(MAKE) --no-print-directory parse PARSE_ARGS=--full
	@$(MAKE) --no-print-directory finalize summarize export granska

parse: $(VENV)/.installed  ## Läser nya eller ändrade PDF-fakturor till tmp/rows.json (inkrementellt)
	@test -d "$(FAKTUROR)" || { echo "Hittar inte fakturamappen: $(FAKTUROR)"; echo 'Ange den med: make parse FAKTUROR="/sökväg/till/Förbrukning" (eller i config.mk)'; exit 1; }
	$(PYTHON) parse.py "$(FAKTUROR)" $(PARSE_ARGS)

finalize: $(VENV)/.installed  ## Normaliserar och skriver tmp/fakturor.csv (kräver att parse körts)
	@test -f "$(WORKDIR)/rows.json" || { echo "Saknar $(WORKDIR)/rows.json. Kör make parse först."; exit 1; }
	$(PYTHON) finalize.py

summarize: $(VENV)/.installed  ## Viktat snittpris per anläggning, bolag och år till tmp/sammanfattning.csv
	@test -f "$(WORKDIR)/fakturor.csv" || { echo "Saknar $(WORKDIR)/fakturor.csv. Kör make finalize först."; exit 1; }
	$(PYTHON) summarize.py

export: $(VENV)/.installed  ## Skriver tmp/data.json som webbsidan läser
	@test -f "$(WORKDIR)/fakturor.csv" || { echo "Saknar $(WORKDIR)/fakturor.csv. Kör make finalize först."; exit 1; }
	$(PYTHON) export_data.py

granska: $(VENV)/.installed  ## Listar fakturor med anmärkning (från 2023). Det här bör vara tomt
	@test -f "$(WORKDIR)/fakturor.csv" || { echo "Saknar $(WORKDIR)/fakturor.csv. Kör make finalize först."; exit 1; }
	$(PYTHON) granska.py

serve: $(VENV)/.installed  ## Startar webbsidan på http://localhost:8765 (Ctrl+C avslutar)
	$(PYTHON) serve.py $(PORT)

start: update serve  ## Kör update och startar sedan webbsidan

spot: $(VENV)/.installed  ## Uppdaterar spotpriserna när en ny månad publicerats, och bygger om data
	@test -f "$(SPOT_PDF)" || { echo "Hittar inte spotpris-PDF:en: $(SPOT_PDF)"; echo 'Ange den med: make spot SPOT_PDF="/sökväg/till/fil.pdf" (eller i config.mk)'; exit 1; }
	$(PYTHON) extract_spotpris.py "$(SPOT_PDF)" --web-year $(SPOT_YEAR)
	@$(MAKE) --no-print-directory finalize summarize export granska

demo: $(VENV)/.installed  ## Skapar påhittad demodata till webbsidan (web/demo-data.js)
	$(PYTHON) export_data.py --demo

test: $(VENV)/.installed  ## Kör alla tester (Python och JavaScript)
	$(PYTHON) -m unittest discover -s tests
	cd web && node --test
