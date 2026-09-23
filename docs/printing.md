# Printing SpeciMap tags

## Materials

- **Laser printer, not inkjet.** Ethanol (and most fixatives) dissolve
  inkjet ink almost instantly; laser toner survives well.
- For wet use, print on **waterproof synthetic paper** (polyester laser
  sheets, e.g. "weatherproof laser labels/sheets"). Ordinary paper works for
  dry collections.

## Print settings — this matters

Print at **100% scale / "Actual Size"**. Printer drivers default to "Fit to
page", which silently shrinks the sheet 3–5% — enough to break the
punch-hole fit over the vial threads.

Every generated sheet includes a **50mm calibration ruler** in the footer.
Before cutting a batch, measure it with a real ruler. If it isn't exactly
50mm, fix your print scaling and reprint.

## Cutting and punching

- **Insert tags** (44×18mm): cut along the hairline borders; the strip drops
  into a 20mL scintillation vial.
- **Punch-hole tags** (38×38mm, 22.5mm hole): cut the square, then cut the
  printed circle with small scissors or a 22–23mm craft punch. A standard
  office hole punch (6mm) is too small. The hole slips over the vial's
  22-400 neck threads and is held under the cap.
- **2mL tube inserts** (8×28mm, QR end up): cut along the hairline borders
  and slide the strip into a clear 2mL screw-cap microcentrifuge tube with
  the QR facing out. The QR is only 6.5mm, so print on a laser printer at
  600dpi or better and scan it through the tube wall from about 5–8cm away.

## Fit check before a big batch

Vial dimensions vary slightly by manufacturer. Print one sheet, fit one of
each style on one of *your* vials, then print the rest. If the fit is off,
the dimensions live in `src/tags/dimensions.ts`.
