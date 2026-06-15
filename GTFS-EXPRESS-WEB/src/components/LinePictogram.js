const LinePictogram = ({ code, backgroundColor, textColor, size }) => {
    // Function to calculate font size based on the code length
    const calculateFontSize = (code, maxSize, minSize, threshold) => {
      if (code.length > threshold) {
        return `${Math.max(minSize, maxSize - (code.length - threshold))}px`;
      }
      return `${maxSize}px`;
    };
  
    // Define the maximum and minimum font sizes and the threshold
    const maxFontSize = size / 2;
    const minFontSize = size / 4; // Set a minimum font size to prevent the text from becoming too small
    const threshold = 1; // Set the threshold for when to start reducing font size
  
    // Calculate the font size for the current code
    const fontSize = calculateFontSize(code, maxFontSize, minFontSize, threshold);
  
    const pictogramStyle = {
      backgroundColor: `#${backgroundColor}`,
      color: `#${textColor}`,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: `${size}px`,
      minWidth: `38px`,
      height: `${size - 8}px`,
      borderRadius: "10px",
      marginRight: "10px",
      fontSize: fontSize, // Use the dynamic font size
      padding: '0 10px',
    };
  
    return (
      <div style={pictogramStyle}>
        {code}
      </div>
    );
  };
  
  export default LinePictogram;
  