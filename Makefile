# Native installer plus a standalone PC setup host.
PYTHON := python3
LOADER ?= $(if $(wildcard third_party/ps5-webkit-remote-loader/installer/common/common.mk),third_party/ps5-webkit-remote-loader,../..)
INSTALLER_COMMON := $(LOADER)/installer/common
include $(INSTALLER_COMMON)/common.mk
SDK := /opt/ps5-payload-sdk
CC := $(SDK)/bin/prospero-clang
STRIP := $(SDK)/bin/prospero-strip
TARGET := $(SDK)/target
CFLAGS := -Os -Wall -ffunction-sections -fdata-sections -Iinclude -I$(INSTALLER_COMMON) -I$(TARGET)/include
LDFLAGS := -Wl,--gc-sections
LIBS := $(TARGET)/lib/libmicrohttpd.a -L$(TARGET)/lib -lpthread \
        -lSceNetCtl -lSceUserService -lSceSystemService -lSceAppInstUtil
SRCS := src/main.c src/http_server.c $(INSTALLER_COMMON_SRCS)
ELF := installer.elf

# One version per make invocation, including dirty-tree builds.
ifndef BUILD_VERSION
BUILD_VERSION := $(shell $(PYTHON) tools/gen_version.py --print)
endif
export BUILD_VERSION

ifndef BUILD_TITLE
BUILD_TITLE := $(shell $(PYTHON) tools/gen_version.py --title)
endif

# Modular autoloader page carrying autoloader.js (unified orchestrator),
# poops.js, relapse.lua, autoload.js, autoload.elf, and elfldr.elf.
# All assets are cached individually via AppCache or served via HTTP.
ELFLDR_TAG ?= $(shell git -C third_party/ps5-elfldr describe --tags --always 2>/dev/null || echo v0.27-b57d0e9)
ELFLDR_VIRTUAL := shared/elfldr-ps5-$(ELFLDR_TAG).elf
APP_PAGE := build/autoloader/index.html
HOST_PAGE := build/host/index.html
STAGE := frontend/dist
REGISTRY := include/file_registry.h include/file_registry.c
ICONS := assets/icon0.png assets/icon.ico
INSTALLER_LOGO := frontend/installer-page/logo.svg
HOST_PAYLOAD ?= $(ELF)
PAYLOAD_TAG ?= $(shell git -C third_party/ps5-unified-autoloader describe --tags --always 2>/dev/null || echo v0.1.6-e7093cd)
AUTOLOAD_PAYLOAD_VIRTUAL ?= ps5-unified-autoloader-$(PAYLOAD_TAG).elf
HOST_PAYLOAD_VIRTUAL ?= $(if $(filter-out installer.elf,$(notdir $(HOST_PAYLOAD))),$(notdir $(HOST_PAYLOAD)),webkit-autoloader-installer_v$(BUILD_VERSION).elf)

# Optional cache-repair hardware test builds; use make clean all when changing.
SIMULATE ?= 0
ifneq ($(SIMULATE),0)
CFLAGS += -DINSTALLER_SIMULATE_CACHE_CORRUPTION=$(SIMULATE)
endif

all: $(ELF)

version:
	$(PYTHON) tools/gen_version.py

print-version:
	@echo $(BUILD_VERSION)

test:
	node tools/test_elfldr_check.js
	node tools/test_autoload_payload.js
	node tools/test_installer.js
	node tools/test_selection_flow.js

# Run on Linux or in the SDK container; PS5 services are stubbed.
test-native:
	$(PYTHON) $(LOADER)/tools/installer_common_test.py

icons: $(ICONS) $(INSTALLER_LOGO)
assets/icon0.png: assets/icon.svg tools/gen_icons.py
	$(PYTHON) tools/gen_icons.py
assets/icon.ico: assets/icon0.png
	@test -f $@ || $(PYTHON) tools/gen_icons.py

$(INSTALLER_LOGO): assets/icon.svg
	cp $< $@

payload-deps:
	./tools/download_deps.sh

# Modular autoloader page directory carrying autoloader.js (orchestrator),
# poops.js, relapse.lua, autoload.js, and payload ELF. Exploit selection
# is determined dynamically at runtime based on FW and network status.
page: payload-deps
	@mkdir -p build/autoloader
	$(PYTHON) tools/build_modular_page.py \
	    --output-dir build/autoloader \
	    --loader-dir $(LOADER) \
	    --title "$(BUILD_TITLE)" \
	    --version $(BUILD_VERSION) \
	    --elfldr-name $(notdir $(ELFLDR_VIRTUAL)) \
	    --elfldr-bin build/deps/elfldr.elf \
	    --payload-name $(AUTOLOAD_PAYLOAD_VIRTUAL) \
	    --payload-bin build/deps/autoload.elf

registry: version page $(INSTALLER_LOGO)
	rm -rf $(STAGE)
	@mkdir -p $(STAGE)/app/$(BUILD_VERSION)
	cp frontend/installer-page/index.html $(INSTALLER_LOGO) $(STAGE)/
	cp frontend/pointer/index.html $(STAGE)/app/index.html
	cp -R build/autoloader/. $(STAGE)/app/$(BUILD_VERSION)/
	@echo "$(BUILD_VERSION)" > $(STAGE)/VERSION
	$(PYTHON) tools/gen_file_registry.py $(STAGE) $(word 1,$(REGISTRY)) $(word 2,$(REGISTRY))

$(ELF): registry icons $(SRCS) $(wildcard include/*.h) $(INSTALLER_COMMON_HEADERS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(SRCS) include/file_registry.c $(LIBS)
	$(STRIP) $@

# The setup host embeds the modular autoloader and installer ELF for PC serving.
host: $(HOST_PAYLOAD) payload-deps assets/icon.ico
	@mkdir -p build/host
	$(PYTHON) tools/build_modular_page.py \
	    --output-dir build/host \
	    --loader-dir $(LOADER) \
	    --title "$(BUILD_TITLE)" \
	    --version $(BUILD_VERSION) \
	    --elfldr-name $(notdir $(ELFLDR_VIRTUAL)) \
	    --elfldr-bin build/deps/elfldr.elf \
	    --payload-name $(HOST_PAYLOAD_VIRTUAL) \
	    --payload-bin $(HOST_PAYLOAD)
	$(PYTHON) $(LOADER)/tools/build_host.py \
	    --dir build/host \
	    --version $(BUILD_VERSION) --name "PS5 WEBKIT AUTOLOADER" --output webkit-autoloader-host.py

dev: page
	$(PYTHON) -m http.server 8123 --bind 127.0.0.1 --directory build/autoloader

clean:
	rm -rf $(STAGE) build/autoloader build/host
	rm -f $(ELF) $(REGISTRY) include/wkali_version.h webkit-autoloader-host.py

.PHONY: all version print-version test test-native icons payload-deps page registry host dev clean
