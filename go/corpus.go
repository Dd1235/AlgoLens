package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// LoadCorpus walks {root}/{platform}/*.json for each platform in order,
// matching the Node loader (server/data.js). File reads are sorted so the
// resulting doc order is identical between Go and Node — important for
// reproducible bench numbers.
func LoadCorpus(root string, platforms []string) ([]Problem, error) {
	var out []Problem
	for _, platform := range platforms {
		dir := filepath.Join(root, platform)
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			fmt.Fprintf(os.Stderr, "skipping missing dir: %s\n", dir)
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, fmt.Errorf("read dir %s: %w", dir, err)
		}
		var files []string
		for _, e := range entries {
			if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
				files = append(files, e.Name())
			}
		}
		sort.Strings(files)
		for _, name := range files {
			path := filepath.Join(dir, name)
			raw, err := os.ReadFile(path)
			if err != nil {
				return nil, fmt.Errorf("read %s: %w", path, err)
			}
			var p Problem
			if err := json.Unmarshal(raw, &p); err != nil {
				fmt.Fprintf(os.Stderr, "bad json %s: %v\n", path, err)
				continue
			}
			out = append(out, p)
		}
	}
	return out, nil
}
