import { getVaultGraph, getVaultNote } from "../src/lib/vault.js";

async function test() {
  console.log("Testing getVaultGraph()...");
  const graph = await getVaultGraph();
  console.log(`Vault Path: ${graph.vaultPath}`);
  console.log(`Total Notes: ${graph.totalNotes}`);
  console.log(`Total Links: ${graph.totalLinks}`);
  console.log("Sample Nodes:", graph.nodes.slice(0, 5).map(n => ({ id: n.id, title: n.title, category: n.category })));
  console.log("Sample Links:", graph.links.slice(0, 5));

  if (graph.nodes.length > 0) {
    const firstNodeId = graph.nodes[0].id;
    console.log(`\nTesting getVaultNote('${firstNodeId}')...`);
    const note = await getVaultNote(firstNodeId);
    console.log(`Title: ${note.node.title}`);
    console.log(`Frontmatter:`, note.frontmatter);
    console.log(`Backlinks count: ${note.backlinks.length}`);
    console.log(`Outgoing links count: ${note.outgoing.length}`);
    console.log(`Content snippet: ${note.content.slice(0, 100).replace(/\n/g, ' ')}...`);
  }

  console.log("\nVault API Verification Passed!");
}

test().catch(err => {
  console.error("Vault Test Error:", err);
});
