import React, { useState, useEffect, useRef, useMemo } from "react";
import { api } from "../lib/api.js";
import "./KnowledgeVault.css";

const CLUSTER_COLORS = {
  Anish: { bg: "#ffb454", glow: "rgba(255, 180, 84, 0.45)", text: "#ffedd5" },
  "BERAM": { bg: "#ff7a6b", glow: "rgba(255, 122, 107, 0.45)", text: "#ffe4e6" },
  "AYUS Labs": { bg: "#4fc3d9", glow: "rgba(79, 195, 217, 0.45)", text: "#cffaff" },
  RCOEM: { bg: "#9d8df1", glow: "rgba(157, 141, 241, 0.45)", text: "#ede9fe" },
  "Anish Projects": { bg: "#6fcf97", glow: "rgba(111, 207, 151, 0.45)", text: "#d1fae5" },
  General: { bg: "#3b82f6", glow: "rgba(59, 130, 246, 0.45)", text: "#dbeafe" },
};

function getClusterTheme(cluster) {
  return CLUSTER_COLORS[cluster] || CLUSTER_COLORS.General;
}

const KIND_LABELS = {
  core: "Identity",
  org: "Organisation",
  hub: "Folder",
  note: "Note",
  project: "Repository",
};

export default function KnowledgeVault({ showToast }) {
  const [loading, setLoading] = useState(true);
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [selectedCluster, setSelectedCluster] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNode, setSelectedNode] = useState(null);
  const [noteDetail, setNoteDetail] = useState(null);
  const [loadingNote, setLoadingNote] = useState(false);
  const [isPhysicsActive, setIsPhysicsActive] = useState(true);

  // Canvas ref & transform state
  const canvasRef = useRef(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const isDraggingCanvasRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const draggedNodeRef = useRef(null);
  const hoveredNodeRef = useRef(null);

  // Physics simulation nodes store
  const simNodesRef = useRef([]);

  // Fetch Graph Data
  const loadGraph = async () => {
    setLoading(true);
    try {
      const data = await api("/vault/graph");
      setGraphData(data);

      const width = canvasRef.current ? canvasRef.current.clientWidth : 900;
      const height = canvasRef.current ? canvasRef.current.clientHeight : 600;

      const nodes = (data.nodes || []).map((n, idx) => {
        const angle = (idx / (data.nodes.length || 1)) * Math.PI * 2;
        const radius = n.kind === "core" ? 0 : 120 + (idx % 7) * 32;
        return {
          ...n,
          x: width / 2 + Math.cos(angle) * radius,
          y: height / 2 + Math.sin(angle) * radius,
          vx: (Math.random() - 0.5) * 1.5,
          vy: (Math.random() - 0.5) * 1.5,
          r: n.kind === "core" ? 18 : n.kind === "org" ? 14 : n.kind === "hub" ? 11 : n.kind === "note" ? 9 : 7,
        };
      });

      simNodesRef.current = nodes;
      setLoading(false);
    } catch (err) {
      console.error("[KnowledgeVault] load error:", err);
      showToast?.(err.message || "Failed to load Knowledge Vault", "error");
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGraph();
  }, []);

  // Load note details when node selected
  const fetchNoteDetails = async (nodeId) => {
    setLoadingNote(true);
    try {
      const data = await api(`/vault/note?id=${encodeURIComponent(nodeId)}`);
      setNoteDetail(data);
    } catch (err) {
      console.error("[KnowledgeVault] note fetch error:", err);
      showToast?.("Could not load note content", "error");
    } finally {
      setLoadingNote(false);
    }
  };

  const handleSelectNode = (node) => {
    setSelectedNode(node);
    fetchNoteDetails(node.id);
  };

  // Filtered nodes
  const filteredNodeIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const nodes = graphData.nodes || [];
    return new Set(
      nodes
        .filter((n) => {
          const clusterMatch = selectedCluster === "All" || n.category === selectedCluster;
          const searchMatch = !query || n.title.toLowerCase().includes(query) || n.relPath.toLowerCase().includes(query) || (n.excerpt && n.excerpt.toLowerCase().includes(query));
          return clusterMatch && searchMatch;
        })
        .map((n) => n.id)
    );
  }, [graphData.nodes, selectedCluster, searchQuery]);

  // Cluster counts
  const clusterCounts = useMemo(() => {
    const nodes = graphData.nodes || [];
    const counts = { All: nodes.length };
    nodes.forEach((n) => {
      counts[n.category] = (counts[n.category] || 0) + 1;
    });
    return counts;
  }, [graphData.nodes]);

  // Canvas Force Simulation & Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animId;

    const render = () => {
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();

      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const { x: tx, y: ty, k } = transformRef.current;
      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(k, k);

      const nodes = simNodesRef.current || [];
      const links = graphData.links || [];
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      // Physics step
      if (isPhysicsActive && !isDraggingCanvasRef.current) {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const n1 = nodes[i];
            const n2 = nodes[j];
            const dx = n2.x - n1.x;
            const dy = n2.y - n1.y;
            const distSq = dx * dx + dy * dy || 1;
            const dist = Math.sqrt(distSq);
            if (dist < 220) {
              const force = (220 - dist) / dist * 0.06;
              const fx = dx * force;
              const fy = dy * force;
              if (n1 !== draggedNodeRef.current) { n1.vx -= fx; n1.vy -= fy; }
              if (n2 !== draggedNodeRef.current) { n2.vx += fx; n2.vy += fy; }
            }
          }
        }

        links.forEach((l) => {
          const source = nodeMap.get(l.source);
          const target = nodeMap.get(l.target);
          if (source && target) {
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = (dist - 85) * 0.004;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            if (source !== draggedNodeRef.current) { source.vx += fx; source.vy += fy; }
            if (target !== draggedNodeRef.current) { target.vx -= fx; target.vy -= fy; }
          }
        });

        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        nodes.forEach((n) => {
          if (n === draggedNodeRef.current) return;
          n.vx += (centerX - n.x) * 0.0004;
          n.vy += (centerY - n.y) * 0.0004;
          n.vx *= 0.86;
          n.vy *= 0.86;
          n.x += n.vx;
          n.y += n.vy;
        });
      }

      // Links
      links.forEach((l) => {
        const source = nodeMap.get(l.source);
        const target = nodeMap.get(l.target);
        if (!source || !target) return;

        const isSourceFiltered = filteredNodeIds.has(source.id);
        const isTargetFiltered = filteredNodeIds.has(target.id);
        const isHovered = hoveredNodeRef.current && (hoveredNodeRef.current.id === source.id || hoveredNodeRef.current.id === target.id);
        const isSelected = selectedNode && (selectedNode.id === source.id || selectedNode.id === target.id);

        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);

        if (isHovered || isSelected) {
          ctx.strokeStyle = "rgba(255, 180, 84, 0.9)";
          ctx.lineWidth = 2.2 / k;
        } else if (isSourceFiltered && isTargetFiltered) {
          ctx.strokeStyle = "rgba(125, 147, 168, 0.28)";
          ctx.lineWidth = 1 / k;
        } else {
          ctx.strokeStyle = "rgba(125, 147, 168, 0.06)";
          ctx.lineWidth = 0.5 / k;
        }

        if (l.type === "d") ctx.setLineDash([4 / k, 4 / k]);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      // Nodes
      nodes.forEach((n) => {
        const isVisible = filteredNodeIds.has(n.id);
        const isHovered = hoveredNodeRef.current?.id === n.id;
        const isSelected = selectedNode?.id === n.id;
        const theme = getClusterTheme(n.category);

        const radius = isSelected ? n.r * 1.4 : isHovered ? n.r * 1.25 : n.r;

        ctx.save();

        // Live Production Halo Ring
        if (n.live && isVisible) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, radius + 5, 0, Math.PI * 2);
          ctx.strokeStyle = theme.bg;
          ctx.lineWidth = 1.2 / k;
          ctx.shadowColor = theme.glow;
          ctx.shadowBlur = 10;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);

        if (isVisible) {
          if (n.remote || n.kind !== "project") {
            ctx.fillStyle = theme.bg;
            ctx.shadowColor = theme.glow;
            ctx.shadowBlur = isHovered || isSelected ? 20 : 8;
            ctx.fill();
          } else {
            ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
            ctx.fill();
            ctx.strokeStyle = theme.bg;
            ctx.lineWidth = 1.6 / k;
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = "rgba(71, 85, 105, 0.15)";
          ctx.shadowBlur = 0;
          ctx.fill();
        }

        if (isSelected) {
          ctx.lineWidth = 3 / k;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
        }

        // Title Labels
        if (isVisible && (k > 0.65 || isHovered || isSelected || n.kind === "core" || n.kind === "org")) {
          ctx.font = `${isSelected || isHovered ? "bold 13px" : "500 11px"} system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = isSelected ? "#ffffff" : isHovered ? "#ffb454" : theme.text;
          ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
          ctx.shadowBlur = 4;
          ctx.fillText(n.title, n.x, n.y + radius + 4);
        }

        ctx.restore();
      });

      ctx.restore();
      ctx.restore();

      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [graphData, filteredNodeIds, selectedNode, isPhysicsActive]);

  // Mouse Interaction Handlers
  const handleMouseDown = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const { x: tx, y: ty, k } = transformRef.current;
    const worldX = (mouseX - tx) / k;
    const worldY = (mouseY - ty) / k;

    const hitNode = simNodesRef.current.find((n) => {
      const dx = n.x - worldX;
      const dy = n.y - worldY;
      return Math.sqrt(dx * dx + dy * dy) <= n.r + 5;
    });

    if (hitNode) {
      draggedNodeRef.current = hitNode;
    } else {
      isDraggingCanvasRef.current = true;
      dragStartRef.current = { x: mouseX - tx, y: mouseY - ty };
    }
  };

  const handleMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const { x: tx, y: ty, k } = transformRef.current;
    const worldX = (mouseX - tx) / k;
    const worldY = (mouseY - ty) / k;

    if (draggedNodeRef.current) {
      draggedNodeRef.current.x = worldX;
      draggedNodeRef.current.y = worldY;
      draggedNodeRef.current.vx = 0;
      draggedNodeRef.current.vy = 0;
    } else if (isDraggingCanvasRef.current) {
      transformRef.current.x = mouseX - dragStartRef.current.x;
      transformRef.current.y = mouseY - dragStartRef.current.y;
    } else {
      const hitNode = simNodesRef.current.find((n) => {
        const dx = n.x - worldX;
        const dy = n.y - worldY;
        return Math.sqrt(dx * dx + dy * dy) <= n.r + 5;
      });
      hoveredNodeRef.current = hitNode || null;
      canvas.style.cursor = hitNode ? "pointer" : "grab";
    }
  };

  const handleMouseUp = () => {
    if (draggedNodeRef.current) {
      handleSelectNode(draggedNodeRef.current);
      draggedNodeRef.current = null;
    }
    isDraggingCanvasRef.current = false;
  };

  // Non-passive wheel listener
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
      const { x: tx, y: ty, k } = transformRef.current;
      const nextK = Math.max(0.15, Math.min(4, k * zoomFactor));

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      transformRef.current = {
        k: nextK,
        x: mouseX - (mouseX - tx) * (nextK / k),
        y: mouseY - (mouseY - ty) * (nextK / k),
      };
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  const resetView = () => {
    transformRef.current = { x: 0, y: 0, k: 1 };
  };

  // Render markdown text & HTML elements cleanly
  const renderMarkdownContent = (text) => {
    if (!text) return null;

    const cleanText = text
      .replace(/<div[^>]*>/gi, "")
      .replace(/<\/div>/gi, "")
      .replace(/<p align="[^"]*">/gi, "")
      .replace(/<\/p>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<sub>|<\/sub>/gi, "")
      .replace(/<picture>|<\/picture>/gi, "")
      .replace(/<source[^>]*>/gi, "");

    const lines = cleanText.split("\n");
    const elements = [];

    let inTable = false;
    let tableRows = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const trimmed = line.trim();

      // Table lines
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        if (!inTable) {
          inTable = true;
          tableRows = [];
        }
        tableRows.push(trimmed);
        continue;
      } else if (inTable) {
        elements.push(renderTableBlock(tableRows, elements.length));
        inTable = false;
        tableRows = [];
      }

      if (!trimmed) {
        elements.push(<div key={idx} className="md-spacer" />);
        continue;
      }

      // Headings
      if (trimmed.startsWith("# ")) {
        elements.push(<h1 key={idx}>{renderFormattedText(trimmed.slice(2))}</h1>);
      } else if (trimmed.startsWith("## ")) {
        elements.push(<h2 key={idx}>{renderFormattedText(trimmed.slice(3))}</h2>);
      } else if (trimmed.startsWith("### ")) {
        elements.push(<h3 key={idx}>{renderFormattedText(trimmed.slice(4))}</h3>);
      } else if (trimmed.startsWith("#### ")) {
        elements.push(<h4 key={idx}>{renderFormattedText(trimmed.slice(5))}</h4>);
      } else if (trimmed.startsWith("---") || trimmed.startsWith("***")) {
        elements.push(<hr key={idx} className="md-hr" />);
      } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        elements.push(<li key={idx}>{renderFormattedText(trimmed.slice(2))}</li>);
      } else if (trimmed.startsWith("```")) {
        elements.push(<div key={idx} className="md-code-fence">{trimmed}</div>);
      } else {
        elements.push(<p key={idx}>{renderFormattedText(trimmed)}</p>);
      }
    }

    if (inTable && tableRows.length > 0) {
      elements.push(renderTableBlock(tableRows, elements.length));
    }

    return elements;
  };

  const renderTableBlock = (rows, keyIndex) => {
    const contentRows = rows.filter((r) => !r.includes("---"));
    if (contentRows.length === 0) return null;

    const headers = contentRows[0].split("|").map((c) => c.trim()).filter(Boolean);
    const bodyRows = contentRows.slice(1).map((r) => r.split("|").map((c) => c.trim()).filter(Boolean));

    return (
      <div key={`table-${keyIndex}`} className="md-table-wrapper">
        <table className="md-table">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i}>{renderFormattedText(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, rIdx) => (
              <tr key={rIdx}>
                {row.map((cell, cIdx) => (
                  <td key={cIdx}>{renderFormattedText(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderFormattedText = (text) => {
    if (!text) return null;

    // Handle HTML <img src="..."> tags
    const htmlImgMatch = text.match(/<img\s+src="([^"]+)"[^>]*\/?>/i);
    if (htmlImgMatch) {
      const src = htmlImgMatch[1];
      return (
        <span className="inline-badge-box">
          <img src={src} alt="" className="md-inline-img" onError={(e) => (e.target.style.display = "none")} />
        </span>
      );
    }

    // Handle [![badge](img_url)](link_url)
    const linkedBadgeMatch = text.match(/\[\!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/);
    if (linkedBadgeMatch) {
      const [, alt, imgUrl, linkUrl] = linkedBadgeMatch;
      return (
        <a href={linkUrl} target="_blank" rel="noreferrer" className="badge-link">
          <img src={imgUrl} alt="" className="md-badge-img" onError={(e) => (e.target.style.display = "none")} />
        </a>
      );
    }

    // Handle standard markdown links [label](url)
    const linkMatch = text.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
      return parts.map((part, i) => {
        const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (m) {
          const [, label, url] = m;
          if (url.startsWith("http")) {
            return (
              <a key={i} href={url} target="_blank" rel="noreferrer" className="md-link">
                {label} ↗
              </a>
            );
          }
        }
        return renderWikilinksInline(part);
      });
    }

    return renderWikilinksInline(text);
  };

  // Render [[Wikilinks]] as clean text links without bracket clutter or pill background boxes
  const renderWikilinksInline = (text) => {
    if (typeof text !== "string") return text;
    const parts = text.split(/(\[\[[^\]]+\]\])/g);
    return parts.map((part, i) => {
      if (part.startsWith("[[") && part.endsWith("]]")) {
        const linkTarget = part.slice(2, -2).split("|")[0].trim();
        const nodeMatch = graphData.nodes.find(
          (n) => n.title.toLowerCase() === linkTarget.toLowerCase() || n.id.toLowerCase() === linkTarget.toLowerCase()
        );
        return (
          <span
            key={i}
            className={`wikilink-text ${nodeMatch ? "clickable" : ""}`}
            onClick={() => nodeMatch && handleSelectNode(nodeMatch)}
            title={nodeMatch ? `Jump to note: ${nodeMatch.title}` : `Link: ${linkTarget}`}
          >
            {linkTarget}
          </span>
        );
      }
      return part;
    });
  };

  return (
    <div className="knowledge-vault-container">
      {/* Header */}
      <div className="vault-header">
        <div className="vault-title-group">
          <h2>
            <span className="vault-icon">◫</span> Knowledge Vault
          </h2>
          <span className="vault-badge">ANISH Second Brain</span>
          <span className="vault-stats">
            {graphData.totalNotes || 0} notes · {graphData.totalLinks || 0} connections
          </span>
        </div>

        <div className="vault-controls">
          <div className="search-box">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="Search vault (e.g. UTMS, BERAM, ayus-ops...)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="clear-btn" onClick={() => setSearchQuery("")}>
                ✕
              </button>
            )}
          </div>

          <button className="icon-btn" onClick={resetView} title="Reset Center">
            🎯 Center
          </button>
          <button
            className={`icon-btn ${isPhysicsActive ? "active" : ""}`}
            onClick={() => setIsPhysicsActive(!isPhysicsActive)}
            title="Toggle Motion"
          >
            {isPhysicsActive ? "⏸ Motion" : "▶ Motion"}
          </button>
          <button className="icon-btn" onClick={loadGraph} title="Refresh Vault">
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Cluster Chips */}
      <div className="category-strip">
        {Object.entries(clusterCounts).map(([cluster, count]) => {
          const theme = getClusterTheme(cluster);
          const isSelected = selectedCluster === cluster;
          return (
            <button
              key={cluster}
              className={`cat-chip ${isSelected ? "on" : ""}`}
              style={{
                borderColor: isSelected ? theme.bg : "transparent",
                color: isSelected ? theme.text : "inherit",
              }}
              onClick={() => setSelectedCluster(cluster)}
            >
              <span className="cat-dot" style={{ background: theme.bg }} />
              {cluster} <em className="cat-count">{count}</em>
            </button>
          );
        })}
      </div>

      {/* Main Viewport */}
      <div className="vault-body">
        <div className="graph-viewport">
          {loading && (
            <div className="vault-loading-overlay">
              <div className="spinner" />
              <span>Scanning ANISH second brain vault...</span>
            </div>
          )}

          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />

          <div className="graph-legend">
            <div className="legend-item"><span className="dot self" /> Anish</div>
            <div className="legend-item"><span className="dot beram" /> BERAM</div>
            <div className="legend-item"><span className="dot ayus" /> AYUS Labs</div>
            <div className="legend-item"><span className="dot rcoem" /> RCOEM</div>
            <div className="legend-item"><span className="dot personal" /> Projects</div>
            <div className="legend-tip">Ring = Live Prod · Hollow = Local Only</div>
          </div>
        </div>

        {/* Selected Node Inspector Drawer */}
        {selectedNode && (
          <aside className="note-inspector-drawer">
            <div className="drawer-header">
              <div className="drawer-title-meta">
                <span
                  className="cat-label-text"
                  style={{ color: getClusterTheme(selectedNode.category).bg }}
                >
                  {KIND_LABELS[selectedNode.kind] || selectedNode.kind} · {selectedNode.category}
                </span>
                <h3 className="drawer-title">{selectedNode.title}</h3>
                <span className="drawer-path">{selectedNode.relPath || selectedNode.fullPath}</span>
              </div>
              <button className="close-drawer-btn" onClick={() => setSelectedNode(null)}>
                ✕
              </button>
            </div>

            {/* Quick Actions & Meta Row */}
            <div className="drawer-actions">
              <span className="meta-info">
                {selectedNode.stack && <span className="stack-text">{selectedNode.stack}</span>}
                {selectedNode.commit && <span> 🕒 {selectedNode.commit}</span>}
              </span>
              <button
                className="action-btn"
                onClick={() => {
                  navigator.clipboard.writeText(selectedNode.fullPath);
                  showToast?.("File path copied to clipboard", "info");
                }}
                title="Copy Full Disk Path"
              >
                📋 Copy Path
              </button>
            </div>

            {/* Structured Metadata DL Grid */}
            <div className="meta-grid-box">
              <dl className="meta-dl">
                <dt>Cluster</dt>
                <dd style={{ color: getClusterTheme(selectedNode.category).bg }}>{selectedNode.category}</dd>

                {selectedNode.stack && (
                  <>
                    <dt>Stack</dt>
                    <dd>{selectedNode.stack}</dd>
                  </>
                )}

                {selectedNode.remote && (
                  <>
                    <dt>Remote</dt>
                    <dd>
                      <a href={`https://${selectedNode.remote}`} target="_blank" rel="noreferrer">
                        {selectedNode.remote} ↗
                      </a>
                    </dd>
                  </>
                )}

                {selectedNode.live && (
                  <>
                    <dt>Live</dt>
                    <dd>
                      <a href={selectedNode.live} target="_blank" rel="noreferrer" className="live-link">
                        🟢 {selectedNode.live.replace(/^https?:\/\//, "")} ↗
                      </a>
                    </dd>
                  </>
                )}
              </dl>
            </div>

            {/* Summary Note Box */}
            {selectedNode.excerpt && (
              <div className="summary-note-box">
                <p>{selectedNode.excerpt}</p>
              </div>
            )}

            {/* Connected Links & Backlinks — Rendered as Clean Text Lists (No Tags/Pills) */}
            {noteDetail && (
              <div className="connections-box">
                {noteDetail.outgoing?.length > 0 && (
                  <div className="conn-group">
                    <h5>Outgoing Links ({noteDetail.outgoing.length})</h5>
                    <ul className="conn-text-list">
                      {noteDetail.outgoing.map((l) => (
                        <li key={l.id}>
                          <a
                            className="conn-text-link"
                            onClick={() => {
                              const targetNode = graphData.nodes.find((n) => n.id === l.id);
                              if (targetNode) handleSelectNode(targetNode);
                            }}
                          >
                            → {l.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {noteDetail.backlinks?.length > 0 && (
                  <div className="conn-group">
                    <h5>Backlinks / Mentioned In ({noteDetail.backlinks.length})</h5>
                    <ul className="conn-text-list">
                      {noteDetail.backlinks.map((b) => (
                        <li key={b.id}>
                          <a
                            className="conn-text-link backlink"
                            onClick={() => {
                              const targetNode = graphData.nodes.find((n) => n.id === b.id);
                              if (targetNode) handleSelectNode(targetNode);
                            }}
                          >
                            ← {b.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Full Markdown Note Content */}
            <div className="note-content-body">
              {loadingNote ? (
                <div className="note-loading">Loading note markdown...</div>
              ) : noteDetail ? (
                renderMarkdownContent(noteDetail.content)
              ) : null}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
