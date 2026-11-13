/**
 * How a line's shape is drawn by its state: the selected or hovered one solid and thick, the first one solid while
 * nothing is selected, the others thin and dashed, stepping back further once one is selected. Given to the layer as
 * `pathOptions`: react-leaflet reads a style given as plain props only when it creates the layer, so a line styled
 * that way would keep its first look whatever is selected afterwards.
 */
export const shapeLineStyle = ({ color, selected = false, hovered = false, primary = false, hasSelection = false }) => {
  const emphasized = selected || hovered;
  return {
    className: "shape-clickable",
    lineCap: "round",
    lineJoin: "round",
    color,
    weight: emphasized ? 6 : primary ? 5 : 3,
    opacity: selected ? 1 : hovered ? 0.9 : primary ? 0.85 : hasSelection ? 0.35 : 0.55,
    dashArray: emphasized || primary ? null : "8 6",
  };
};
