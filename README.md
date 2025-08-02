# NAKODX: Retrieve File from Server

**NAKODX: Retrieve File from Server** is a Visual Studio Code extension designed for Salesforce developers to quickly and easily retrieve metadata files directly from a Salesforce org.

---

## Features

### Retrieve Salesforce Metadata Quickly
- Use the command `NAKODX: Retrieve File from Server` to rapidly select and download any metadata type (e.g., `ApexClass`, `LightningComponentBundle`) directly from your Salesforce org.
- The extension provides an intuitive interface where you can start typing the metadata type or item name to quickly filter the results.

### Caching for Performance
- Metadata types and their items are cached per Salesforce org. This caching ensures faster retrieval on subsequent requests, significantly enhancing performance when working with large orgs.

### Cache Management
- The extension includes cache management commands:
  - **Clear Types Cache:** `NAKODX: Retrieve File from Server - Clear Types Cache`
  - **Clear Items Cache:** `NAKODX: Retrieve File from Server - Clear Items Cache`

These commands allow you to manually refresh caches to retrieve the latest metadata from your Salesforce org.

---

## Usage

1. Open the command palette (`Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows).
2. Start typing `NAKODX: Retrieve File from Server` and select it.
3. Choose the metadata type from the presented list or start typing to filter quickly.
4. After selecting the metadata type, choose the specific metadata item from the presented list.

The selected metadata file will be downloaded and opened in your workspace automatically.

![Extension demo](nakodx-retrieve-file-demo.gif)

---

## Commands

| Command Name                                          | Description                                       |
|-------------------------------------------------------|---------------------------------------------------|
| `NAKODX: Retrieve File from Server`                   | Retrieve metadata file from Salesforce server.    |
| `NAKODX: Retrieve File from Server - Clear Types Cache`| Clears the cached metadata types for the current org.|
| `NAKODX: Retrieve File from Server - Clear Items Cache`| Clears the cached metadata items for the current org.|

---

## Requirements

- Salesforce CLI (sf) installed and configured.
- VSCode.

---

## Support and Feedback

For issues, feedback, or feature requests, please open an issue on the project's repository.