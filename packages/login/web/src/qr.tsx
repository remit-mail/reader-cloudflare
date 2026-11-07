import QRCode from "qrcode";

export const QrCode = ({ value }: { value: string }) => {
  const { modules } = QRCode.create(value, { errorCorrectionLevel: "M" });
  const size = modules.size;
  let path = "";
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (modules.get(row, column)) path += `M${column} ${row}h1v1h-1z`;
    }
  }
  return (
    <svg
      className="size-48 rounded-md bg-white p-2"
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      role="img"
      aria-label="QR code"
    >
      <path d={path} fill="#000000" />
    </svg>
  );
};
